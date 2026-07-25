/**
 * kitchen-alert.ts
 * โมดูลแจ้งเตือนออเดอร์สำหรับหน้าจอครัว (เว็บบนมือถือ/แท็บเล็ต)
 *
 * แก้ปัญหา 4 อย่างที่ทำให้เสียงเตือนบนเว็บไม่น่าเชื่อถือ:
 *   1. browser บล็อกเสียงจนกว่าผู้ใช้จะแตะจอ  -> unlock() ต้องเรียกใน event ของการแตะ
 *   2. AudioContext ถูก suspend ตอนสลับแอป     -> resume ทุกครั้งที่กลับมา + oscillator gain 0 กันหลับ
 *   3. จอดับแล้วทุกอย่างหยุด                    -> Screen Wake Lock + re-acquire อัตโนมัติ
 *   4. SSE ค้างแบบไม่รู้ตัว (มือถือ/4G เจอบ่อย) -> heartbeat watchdog + ดึงออเดอร์ที่พลาดกลับมา
 *
 * หลักการสำคัญ: เสียงดังซ้ำจนกว่าจะมีคนกดรับ ไม่ใช่ดังครั้งเดียวแล้วจบ
 */

type Order = { id: string; createdAt: string; [k: string]: unknown };

type AlertOptions = {
  /** endpoint SSE ฝั่ง server */
  streamUrl: string;
  /** endpoint ดึงออเดอร์ที่พลาดไปตอนหลุด: GET ?since=<cursor> */
  recoverUrl: string;
  /** เว้นกี่ ms ระหว่างเสียงแต่ละครั้ง จนกว่าจะกดรับ */
  repeatMs?: number;
  /** ไม่ได้ยิน heartbeat นานเกินนี้ = ถือว่าสายตายแล้ว บังคับต่อใหม่ */
  heartbeatTimeoutMs?: number;
  onOrders: (orders: Order[]) => void;
  onConnectionChange?: (online: boolean) => void;
};

export class KitchenAlert {
  private ctx: AudioContext | null = null;
  private keepAlive: OscillatorNode | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private es: EventSource | null = null;
  private repeatTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private cursor: string | null = null;
  private opts: Required<Pick<AlertOptions, 'repeatMs' | 'heartbeatTimeoutMs'>> & AlertOptions;

  /** มีออเดอร์ค้างที่ยังไม่มีคนกดรับหรือไม่ */
  public pending = false;

  constructor(opts: AlertOptions) {
    this.opts = { repeatMs: 4000, heartbeatTimeoutMs: 40000, ...opts };
  }

  // ─────────────────────────────────────────────────────────
  // 1) ปลดล็อกเสียง — ต้องเรียกจากใน onClick ของปุ่ม "เริ่มรับออเดอร์" เท่านั้น
  //    เรียกจากที่อื่น browser จะไม่ยอมให้เล่นเสียง
  // ─────────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AC();

      // oscillator ที่ดังเป็น 0 ตลอดเวลา กัน iOS/Android ปิด audio session ทิ้ง
      const silent = this.ctx.createGain();
      silent.gain.value = 0;
      silent.connect(this.ctx.destination);
      this.keepAlive = this.ctx.createOscillator();
      this.keepAlive.connect(silent);
      this.keepAlive.start();
    }

    await this.ctx.resume();
    this.beep(0.05, 120); // เสียงสั้นๆ ยืนยันให้คนกดรู้ว่าเสียงใช้ได้จริง

    await this.acquireWakeLock();
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.connect);

    this.connect();
  }

  stop(): void {
    this.silence();
    this.es?.close();
    this.es = null;
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.connect);
  }

  private onVisible = async () => {
    if (document.visibilityState !== 'visible') return;
    // กลับมาจาก background: audio ถูก suspend, wake lock หลุด, SSE อาจตายไปแล้ว
    await this.ctx?.resume();
    await this.acquireWakeLock();
    if (this.es?.readyState !== EventSource.OPEN) this.connect();
    if (this.pending) this.ring(); // ยังไม่มีใครกดรับ ก็ดังต่อ
  };

  // ─────────────────────────────────────────────────────────
  // 2) เสียง — สร้างสดด้วย Web Audio ไม่โหลดไฟล์
  //    ข้อดี: ไม่มี network dependency, ไม่โดน media session ของ OS แย่งไป
  // ─────────────────────────────────────────────────────────
  private beep(volume = 0.6, durationMs = 200, freq = 880): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;

    const t = ctx.currentTime;
    const dur = durationMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, t);
    // ramp สั้นๆ กันเสียง "ป๊อก" ตอนเริ่ม/จบ
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.01);
    gain.gain.setValueAtTime(volume, t + dur - 0.02);
    gain.gain.linearRampToValueAtTime(0, t + dur);

    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** ดังซ้ำไปเรื่อยๆ จนกว่าจะเรียก acknowledge() */
  private ring(): void {
    this.silence();
    const pattern = () => {
      this.beep(0.7, 180, 880);
      window.setTimeout(() => this.beep(0.7, 180, 1174), 220);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    };
    pattern();
    this.repeatTimer = window.setInterval(pattern, this.opts.repeatMs);
  }

  private silence(): void {
    if (this.repeatTimer !== null) {
      window.clearInterval(this.repeatTimer);
      this.repeatTimer = null;
    }
  }

  /** เรียกตอนพนักงานกดปุ่ม "รับออเดอร์" */
  acknowledge(): void {
    this.pending = false;
    this.silence();
  }

  // ─────────────────────────────────────────────────────────
  // 3) Wake Lock — กันจอดับ ต้องขอใหม่ทุกครั้งที่กลับมา foreground
  // ─────────────────────────────────────────────────────────
  private async acquireWakeLock(): Promise<void> {
    if (!('wakeLock' in navigator)) return; // iOS < 16.4 ไม่มี — ต้องพึ่ง server watchdog แทน
    if (this.wakeLock && !this.wakeLock.released) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // ขอไม่ได้ (แบตต่ำ / ไม่ได้อยู่ foreground) ไม่ใช่ error ร้ายแรง ปล่อยผ่าน
    }
  }

  // ─────────────────────────────────────────────────────────
  // 4) SSE + watchdog + กู้ออเดอร์ที่พลาด
  // ─────────────────────────────────────────────────────────
  private connect = (): void => {
    this.es?.close();

    const url = new URL(this.opts.streamUrl, location.origin);
    if (this.cursor) url.searchParams.set('since', this.cursor);
    this.es = new EventSource(url.toString(), { withCredentials: true });

    this.es.onopen = () => {
      this.opts.onConnectionChange?.(true);
      this.armWatchdog();
      // ต่อติดแล้วเช็คทุกครั้งว่าพลาดอะไรไประหว่างที่หลุด
      this.recoverMissed();
    };

    // server ต้องส่ง comment ping ทุก ~15 วิ เพื่อให้ watchdog รู้ว่าสายยังเป็น
    this.es.addEventListener('ping', () => this.armWatchdog());

    this.es.addEventListener('order', (e) => {
      this.armWatchdog();
      const orders: Order[] = JSON.parse((e as MessageEvent).data);
      this.handle(orders);
    });

    this.es.onerror = () => {
      this.opts.onConnectionChange?.(false);
      // EventSource ต่อใหม่เองอยู่แล้ว แต่ถ้ามันปิดสนิทต้องช่วยมัน
      if (this.es?.readyState === EventSource.CLOSED) {
        window.setTimeout(this.connect, 3000);
      }
    };
  };

  /**
   * ตัวจับสายตาย: บนมือถือ SSE ค้างแบบ readyState ยังเป็น OPEN ได้บ่อยมาก
   * ถ้าเงียบเกิน heartbeatTimeoutMs = ไม่เชื่อแล้ว ตัดแล้วต่อใหม่
   */
  private armWatchdog(): void {
    if (this.heartbeatTimer !== null) window.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = window.setTimeout(() => {
      this.opts.onConnectionChange?.(false);
      this.connect();
    }, this.opts.heartbeatTimeoutMs);
  }

  private async recoverMissed(): Promise<void> {
    try {
      const url = new URL(this.opts.recoverUrl, location.origin);
      if (this.cursor) url.searchParams.set('since', this.cursor);
      const res = await fetch(url.toString(), { credentials: 'include' });
      if (!res.ok) return;
      const orders: Order[] = await res.json();
      if (orders.length) this.handle(orders);
    } catch {
      // ต่อไม่ติด เดี๋ยว watchdog จะพามาลองใหม่เอง
    }
  }

  private handle(orders: Order[]): void {
    if (!orders.length) return;
    // กันออเดอร์ซ้ำจากการที่ SSE กับ recover ส่งมาชนกัน — ให้ฝั่งเรียกใช้ dedupe ด้วย id
    this.cursor = orders[orders.length - 1].id;
    this.pending = true;
    this.opts.onOrders(orders);
    this.ring();
  }
}

/* ─────────────────────────────────────────────────────────
   ตัวอย่างการใช้ใน React

   const alertRef = useRef<KitchenAlert>();
   const [armed, setArmed] = useState(false);

   const handleOpen = async () => {          // <- ต้องอยู่ใน onClick
     alertRef.current = new KitchenAlert({
       streamUrl: '/api/kitchen/stream',
       recoverUrl: '/api/kitchen/missed',
       onOrders: (o) => setOrders((prev) => dedupeById([...prev, ...o])),
       onConnectionChange: setOnline,
     });
     await alertRef.current.start();
     setArmed(true);
   };

   {!armed && <button onClick={handleOpen}>เริ่มรับออเดอร์</button>}
   {alertRef.current?.pending && (
     <button onClick={() => alertRef.current!.acknowledge()}>รับออเดอร์</button>
   )}

   ───────────────────────────────────────────────────────── */