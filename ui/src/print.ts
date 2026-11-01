// Printing is the browser's: a page in a hidden frame, then its print dialog. A receipt printer
// that the browser knows prints it as it would any page; talking to a printer directly is not here.

export function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  document.body.append(frame);
  const w = frame.contentWindow;
  if (!w) return frame.remove();
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
  setTimeout(() => frame.remove(), 60_000);
}
