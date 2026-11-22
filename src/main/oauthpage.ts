import appIcon from '../../scripts/icons/app.svg?raw';

/**
 * The page the browser shows when an OAuth 2.0 sign-in comes back to DialCatz (#100): the app's icon with a mark for
 * how it went, in DialCatz's own colours, light or dark as the browser is. It is served from the loopback listener,
 * so everything is inline: no file, font or script is fetched.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
// The icon as drawn for the app (scripts/icons/app.svg), without its comment and fixed size.
const ICON = appIcon
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<\?xml[^>]*\?>/, '')
  .replace(/(<svg[^>]*?)\s(?:width|height)="[^"]*"/g, '$1')
  .replace(/(<svg[^>]*?)\s(?:width|height)="[^"]*"/g, '$1')
  .trim();

const CSS = `
:root{--bg:oklch(96.5% .006 285);--card:oklch(99.5% .003 285);--line:oklch(90.5% .009 285);--ink:oklch(32% .02 280);--soft:oklch(50% .02 280);--primary:oklch(73% .11 178);--primary-ink:oklch(50% .09 182);--ok:oklch(70% .13 165);--bad:oklch(64% .19 25);--glow:oklch(73% .11 178 / .22)}
@media (prefers-color-scheme:dark){:root{--bg:oklch(21% .014 282);--card:oklch(26.5% .014 282);--line:oklch(33% .016 282);--ink:oklch(89% .01 282);--soft:oklch(70% .012 282);--primary:oklch(77% .11 178);--primary-ink:oklch(77% .11 178);--glow:oklch(77% .11 178 / .16)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:24px;color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(60rem 32rem at 50% -8rem,var(--glow),transparent 70%),var(--bg)}
main{width:100%;max-width:27rem;padding:2.25rem 2rem 1.5rem;border-radius:20px;background:var(--card);border:1px solid var(--line);box-shadow:0 1px 2px rgb(0 0 0 / .04),0 18px 48px -18px rgb(0 0 0 / .22);text-align:center;animation:in .35s cubic-bezier(.2,.8,.2,1) both}
@keyframes in{from{opacity:0;transform:translateY(8px) scale(.985)}}
@media (prefers-reduced-motion:reduce){main{animation:none}}
.icon{position:relative;width:5.25rem;height:5.25rem;margin:0 auto 1.25rem}
.icon>svg{display:block;width:100%;height:100%;filter:drop-shadow(0 8px 14px rgb(0 0 0 / .16))}
.mark{position:absolute;right:-.45rem;bottom:-.35rem;width:1.9rem;height:1.9rem;border-radius:50%;display:grid;place-items:center;color:#fff;border:3px solid var(--card)}
.mark.ok{background:var(--ok)}.mark.bad{background:var(--bad)}
.mark svg{width:1rem;height:1rem;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0 0 .4rem;font-size:1.3rem;line-height:1.3;font-weight:650;letter-spacing:-.012em}
p{margin:0;color:var(--soft)}
.why{margin-top:.9rem;padding:.6rem .8rem;border-radius:10px;border:1px solid var(--line);background:color-mix(in oklab,var(--bad) 7%,transparent);color:var(--ink);font:500 .85rem/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
footer{margin-top:1.6rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.8rem;color:var(--soft);display:flex;align-items:center;justify-content:center;gap:.45rem}
footer b{font-weight:600;color:var(--primary-ink)}
footer i{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.6}
`.replace(/\n/g, '');

const TICK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const BANG = '<svg viewBox="0 0 24 24"><path d="M12 6v8M12 18.2v.1"/></svg>';

/** `detail`: what the provider said, shown as it came (escaped). */
export function oauthPage(ok: boolean, title: string, text: string, detail = ''): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">` +
    `<title>${esc(title)} · DialCatz</title><style>${CSS}</style></head><body><main>` +
    `<div class="icon">${ICON}<span class="mark ${ok ? 'ok' : 'bad'}">${ok ? TICK : BANG}</span></div>` +
    `<h1>${esc(title)}</h1><p>${esc(text)}</p>${detail ? `<div class="why">${esc(detail)}</div>` : ''}` +
    `<footer><b>DialCatz</b><i></i><span>OAuth 2.0 sign-in</span></footer></main></body></html>`
  );
}
