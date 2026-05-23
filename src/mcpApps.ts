export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";

export const UI_RESOURCE_META_KEY = "ui/resourceUri";
export const OPENAI_OUTPUT_TEMPLATE_META_KEY = "openai/outputTemplate";
export const OPENAI_WIDGET_ACCESSIBLE_META_KEY = "openai/widgetAccessible";
export const OPENAI_WIDGET_DESCRIPTION_META_KEY = "openai/widgetDescription";
export const OPENAI_WIDGET_PREFERS_BORDER_META_KEY = "openai/widgetPrefersBorder";
export const OPENAI_WIDGET_CSP_META_KEY = "openai/widgetCSP";

export const UI_RESOURCES = {
	mentorCards: "ui://adplist/mentor-cards.html",
	slotPicker: "ui://adplist/slot-picker.html",
	sessionCards: "ui://adplist/session-cards.html",
} as const;

export type AppViewKind = "mentor-cards" | "slot-picker" | "session-cards";

export function appServerCapabilities() {
	return {
		extensions: {
			[MCP_APP_EXTENSION_ID]: {},
		},
	};
}

const RESOURCE_DOMAINS = [
	"https://adplist.org",
	"https://*.adplist.org",
	"https://images.ctfassets.net",
	"https://*.cloudinary.com",
	"https://lh3.googleusercontent.com",
	"https://avatars.githubusercontent.com",
];

export function appToolMeta(resourceUri: string) {
	return {
		ui: {
			resourceUri,
			visibility: ["model", "app"],
		},
		[UI_RESOURCE_META_KEY]: resourceUri,
		[OPENAI_OUTPUT_TEMPLATE_META_KEY]: resourceUri,
		[OPENAI_WIDGET_ACCESSIBLE_META_KEY]: true,
	};
}

export function appResourceMeta(description = "Interactive ADPList MCP App UI") {
	return {
		ui: {
			prefersBorder: true,
			csp: {
				resourceDomains: RESOURCE_DOMAINS,
			},
		},
		[OPENAI_WIDGET_DESCRIPTION_META_KEY]: description,
		[OPENAI_WIDGET_PREFERS_BORDER_META_KEY]: true,
		[OPENAI_WIDGET_CSP_META_KEY]: {
			resource_domains: RESOURCE_DOMAINS,
		},
	};
}

export function buildAppHtml(kind: AppViewKind): string {
	const title =
		kind === "mentor-cards"
			? "ADPList mentor matches"
			: kind === "slot-picker"
				? "Choose a mentorship time"
				: "ADPList sessions";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, #fff);
  --card: var(--color-background-secondary, #fff);
  --card-soft: var(--color-background-tertiary, #f7f7f7);
  --text: var(--color-text-primary, #222);
  --muted: var(--color-text-secondary, #6a6a6a);
  --line: var(--color-border-primary, #e8e8e8);
  --accent: #ff385c;
  --accent-dark: #d70466;
  --radius: 22px;
  font-family: var(--font-sans, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.app { padding: 18px; max-width: 920px; margin: 0 auto; }
.header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; margin-bottom: 16px; }
h1 { margin: 0; font-size: 22px; line-height: 1.15; letter-spacing: -0.03em; }
.subtle { color: var(--muted); font-size: 13px; line-height: 1.4; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,.06); }
.mentor-photo { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: linear-gradient(135deg, #f3f3f3, #e9e9e9); }
.card-body { padding: 14px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.name { font-weight: 750; letter-spacing: -0.02em; }
.meta { color: var(--muted); font-size: 13px; margin-top: 3px; }
.chips { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 11px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 5px 8px; font-size: 12px; color: var(--text); background: var(--card-soft); }
.stat { font-size: 12px; color: var(--muted); white-space: nowrap; }
.cta { width: 100%; margin-top: 13px; border: 0; border-radius: 999px; padding: 10px 12px; color: #fff; background: linear-gradient(135deg, var(--accent), var(--accent-dark)); font-weight: 700; cursor: pointer; }
.cta.secondary { width: auto; margin-top: 0; background: var(--text); padding: 8px 11px; font-size: 12px; }
.days { display: flex; gap: 10px; overflow-x: auto; padding: 4px 0 12px; }
.day { min-width: 128px; border: 1px solid var(--line); border-radius: 18px; padding: 12px; background: var(--card); cursor: pointer; text-align: left; }
.day.active { border-color: var(--text); box-shadow: inset 0 0 0 1px var(--text); }
.day strong { display: block; font-size: 14px; }
.slots { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.slot { border: 1px solid var(--line); border-radius: 16px; padding: 12px; background: var(--card); cursor: pointer; text-align: left; }
.slot:hover, .slot.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.slot-time { font-weight: 750; }
.session { padding: 16px; display: grid; gap: 12px; }
.badge { display: inline-flex; width: fit-content; border-radius: 999px; padding: 5px 9px; background: var(--card-soft); border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.people { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; }
.person { min-width: 0; }
.arrow { color: var(--muted); }
.empty { border: 1px dashed var(--line); border-radius: var(--radius); padding: 22px; color: var(--muted); text-align: center; }
@media (max-width: 520px) { .app { padding: 12px; } .header { display: block; } .people { grid-template-columns: 1fr; } .arrow { display: none; } }
</style>
</head>
<body>
<main class="app">
  <div class="header"><div><h1>${escapeHtml(title)}</h1><div id="subtitle" class="subtle">Loading ADPList results…</div></div></div>
  <section id="root"><div class="empty">Waiting for the MCP tool result.</div></section>
</main>
<script>
const VIEW_KIND = ${JSON.stringify(kind)};
let lastId = 1;
const pendingRequests = new Map();
function request(method, params, timeoutMs = 5000) {
  const id = lastId++;
  parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(method + ' timed out'));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
  });
}
function send(method, params) { request(method, params).catch((error) => console.warn('MCP Apps request failed', error)); }
function notify(method, params) { parent.postMessage({ jsonrpc: '2.0', method, params }, '*'); }
async function connectToHost() {
  try {
    await request('ui/initialize', {
      appInfo: { name: titleForView(), version: '0.1.0' },
      appCapabilities: {},
      protocolVersion: '2026-01-26'
    });
  } catch (error) {
    console.warn('MCP Apps host initialization failed', error);
  } finally {
    notify('ui/notifications/initialized', {});
    resize();
  }
}
function titleForView() { return VIEW_KIND === 'mentor-cards' ? 'ADPList mentor cards' : VIEW_KIND === 'slot-picker' ? 'ADPList slot picker' : 'ADPList session cards'; }
function resize() { notify('ui/notifications/size-changed', { height: Math.ceil(document.documentElement.scrollHeight), width: Math.ceil(document.documentElement.scrollWidth) }); }
new ResizeObserver(resize).observe(document.body);
window.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (Object.prototype.hasOwnProperty.call(msg, 'id') && pendingRequests.has(msg.id)) {
    const pending = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.error) pending.reject(new Error(msg.error.message || 'MCP Apps request failed'));
    else pending.resolve(msg.result);
    return;
  }
  if (msg.method === 'ui/notifications/tool-result') render(msg.params);
});
connectToHost();
function parseResult(result) {
  if (result && result.structuredContent) return result.structuredContent;
  const text = result?.content?.find?.((item) => item.type === 'text')?.text;
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
function h(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function sendUserMessage(text) { send('ui/message', { role: 'user', content: [{ type: 'text', text }] }); }
function render(result) {
  const data = parseResult(result);
  if (VIEW_KIND === 'mentor-cards') return renderMentors(data);
  if (VIEW_KIND === 'slot-picker') return renderSlots(data);
  renderSessions(data);
}
function renderMentors(data) {
  const mentors = data.mentors || [];
  document.getElementById('subtitle').textContent = mentors.length ? 'Pick a mentor to see available times. Photos are shown when ADPList has them.' : 'No mentor matches returned.';
  document.getElementById('root').innerHTML = mentors.length ? '<div class="grid">' + mentors.map((m) => {
    const photo = m.profile_photo_url || '';
    const fallback = 'https://adplist.org/images/adplist-logo.png';
    const details = [m.title, m.company].filter(Boolean).join(' · ');
    return '<article class="card">' +
      '<img class="mentor-photo" src="' + h(photo || fallback) + '" alt="' + h(m.name) + ' profile photo" loading="lazy" />' +
      '<div class="card-body"><div class="row"><div><div class="name">' + h(m.name || 'ADPList mentor') + '</div><div class="meta">' + h(details) + '</div></div><div class="stat">' + h(m.rating ? '★ ' + Number(m.rating).toFixed(1) : '') + '</div></div>' +
      '<div class="chips">' + (m.expertise || []).map((x) => '<span class="chip">' + h(x) + '</span>').join('') + '</div>' +
      '<div class="meta" style="margin-top:10px">' + h(m.why_match || '') + '</div>' +
      '<button class="cta" data-slug="' + h(m.slug) + '">See available times</button></div></article>';
  }).join('') + '</div>' : '<div class="empty">No mentors found. Try a broader goal or fewer filters.</div>';
  document.querySelectorAll('[data-slug]').forEach((button) => button.addEventListener('click', () => sendUserMessage('Show available times for mentor ' + button.dataset.slug)));
  resize();
}
function renderSlots(data) {
  const slots = data.slots || [];
  document.getElementById('subtitle').textContent = slots.length ? 'Select a date, then choose a time. The final booking still needs chat confirmation.' : 'No available slots returned.';
  if (!slots.length) { document.getElementById('root').innerHTML = '<div class="empty">No available times in this window.</div>'; return resize(); }
  const byDay = slots.reduce((acc, slot) => { const date = new Date(slot.slot_iso); const key = localDayKey(date); (acc[key] ||= []).push(slot); return acc; }, {});
  const days = Object.keys(byDay).sort();
  let active = days[0];
  function paint() {
    const dayButtons = days.map((day) => '<button class="day ' + (day === active ? 'active' : '') + '" data-day="' + day + '"><strong>' + h(localDayLabel(day)) + '</strong><span class="subtle">' + byDay[day].length + ' time' + (byDay[day].length === 1 ? '' : 's') + '</span></button>').join('');
    const slotButtons = byDay[active].map((slot) => '<button class="slot" data-slot="' + h(slot.slot_iso) + '" data-mentor="' + h(slot.mentor_slug) + '"><div class="slot-time">' + h(new Date(slot.slot_iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })) + '</div><div class="subtle">' + h(slot.duration_minutes) + ' min · ' + h(slot.slot_local_display) + '</div></button>').join('');
    document.getElementById('root').innerHTML = '<div class="days">' + dayButtons + '</div><div class="slots">' + slotButtons + '</div>' + (data.truncated ? '<p class="subtle">Showing the first available times. Ask for a wider window if needed.</p>' : '');
    document.querySelectorAll('[data-day]').forEach((button) => button.addEventListener('click', () => { active = button.dataset.day; paint(); }));
    document.querySelectorAll('[data-slot]').forEach((button) => button.addEventListener('click', () => { button.classList.add('selected'); sendUserMessage('I choose ' + button.dataset.slot + ' for mentor ' + button.dataset.mentor + '. Please confirm the booking details.'); }));
    resize();
  }
  paint();
}
function localDayKey(date) {
  const parts = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return get('year') + '-' + get('month') + '-' + get('day');
}
function localDayLabel(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function renderSessions(data) {
  const sessions = data.sessions || (data.session_id ? [data] : []);
  document.getElementById('subtitle').textContent = sessions.length ? 'Your mentorship sessions, with status and next action.' : 'No sessions returned.';
  document.getElementById('root').innerHTML = sessions.length ? '<div class="grid">' + sessions.map((s) => '<article class="card session"><span class="badge">' + h(s.status || 'requested') + '</span><div><div class="name">' + h(s.scheduled_at_local_display || s.expected_confirmation_time || 'Session requested') + '</div><div class="meta">' + h(s.duration_minutes ? s.duration_minutes + ' minutes' : s.session_url || '') + '</div></div>' +
    '<div class="people"><div class="person"><div class="name">' + h(s.mentor?.name || 'Mentor') + '</div><div class="meta">' + h([s.mentor?.title, s.mentor?.organization].filter(Boolean).join(' · ')) + '</div></div><div class="arrow">→</div><div class="person"><div class="name">' + h(s.mentee?.name || 'Mentee') + '</div><div class="meta">' + h([s.mentee?.title, s.mentee?.organization].filter(Boolean).join(' · ')) + '</div></div></div>' +
    (s.session_url ? '<button class="cta secondary" data-url="' + h(s.session_url) + '">Open session</button>' : '') + '</article>').join('') + '</div>' : '<div class="empty">No sessions to show.</div>';
  document.querySelectorAll('[data-url]').forEach((button) => button.addEventListener('click', () => send('ui/open-link', { url: button.dataset.url })));
  resize();
}
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
