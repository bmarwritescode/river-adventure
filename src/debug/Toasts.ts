/** Brief on-screen messages (zone enter/exit, "position copied", etc.). */
export class Toasts {
  private readonly el = document.createElement('div');

  constructor() {
    this.el.className = 'toasts';
    document.body.appendChild(this.el);
  }

  show(text: string, seconds = 2): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    this.el.appendChild(t);
    while (this.el.childElementCount > 4) this.el.firstElementChild?.remove();
    window.setTimeout(() => t.classList.add('fade'), seconds * 1000);
    window.setTimeout(() => t.remove(), seconds * 1000 + 450);
  }

  dispose(): void {
    this.el.remove();
  }
}
