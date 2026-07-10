export function log(msg: string): void {
  const ts = new Date().toLocaleTimeString("fi-FI");
  console.log(`[${ts}] ${msg}`);
}
