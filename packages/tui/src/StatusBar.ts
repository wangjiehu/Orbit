import picocolors from 'picocolors';

export class StatusBar {
  private timer: NodeJS.Timeout | null = null;
  private message = '';
  private startTime = 0;
  private isActive = false;
  private spinnerFrame = 0;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private originalWrite = process.stdout.write.bind(process.stdout);
  private originalErrWrite = process.stderr.write.bind(process.stderr);

  constructor() {}

  public start(message: string): void {
    if (this.isActive) return;
    this.isActive = true;
    this.message = message;
    this.startTime = Date.now();
    this.spinnerFrame = 0;

    process.stdout.write = (chunk: any, encoding?: any, cb?: any) => {
      this.clearStatus();
      const res = this.originalWrite(chunk, encoding, cb);
      this.drawStatus();
      return res;
    };

    process.stderr.write = (chunk: any, encoding?: any, cb?: any) => {
      this.clearStatus();
      const res = this.originalErrWrite(chunk, encoding, cb);
      this.drawStatus();
      return res;
    };

    this.timer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerFrames.length;
      this.drawStatus();
    }, 100);
  }

  public update(message: string): void {
    this.message = message;
    this.drawStatus();
  }

  public stop(): void {
    if (!this.isActive) return;
    this.isActive = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.clearStatus();

    process.stdout.write = this.originalWrite;
    process.stderr.write = this.originalErrWrite;
  }

  private drawStatus(): void {
    if (!this.isActive) return;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const spinner = this.spinnerFrames[this.spinnerFrame];
    const statusLine = `\r${picocolors.cyan(spinner)} ${this.message} (${elapsed}s)`;
    this.originalWrite(statusLine);
  }

  private clearStatus(): void {
    this.originalWrite('\r\x1b[K');
  }
}
