const fs = require("fs");
const path = require("path");
const Babel = require("@babel/standalone");

const HTML = path.join(__dirname, "../index.html");
const html = fs.readFileSync(HTML, "utf8");

// 1. Extract the text/babel block
const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!m) { console.error("FAIL: no text/babel script block found"); process.exit(1); }
let src = m[1];

// 2. Strip the render call so we can evaluate the module without a DOM
src = src.replace(/ReactDOM\.createRoot\([\s\S]*?\);\s*$/, "");

// 3. Compile JSX — this is the syntax check
let code;
try {
  // classic runtime = React.createElement, matching how <script type="text/babel"> compiles in the browser
  code = Babel.transform(src, { presets: [["react", { runtime: "classic" }]], filename: "index.html" }).code;
} catch (e) {
  console.error("FAIL: JSX/JS did not compile\n" + e.message);
  process.exit(1);
}
console.log("PASS  jsx compiles");

// 4. Evaluate with stubbed React and expose the pure helpers
const noop = () => {};
const React = { useState: () => [undefined, noop], useEffect: noop, useRef: () => ({current:null}),
                useCallback: f => f, useMemo: f => f(), createElement: () => null };
const EXPORTS = ["businessDaysSince","parseCSV","splitCSVLine","extractJSON","extractBody",
                 "buildRaw","decodeB64Url","initials","fmtDate","header","messageId",
                 "CAT","CATEGORY_KEYS","CATEGORIES","EMPTY_CAMPAIGN","MODEL","App",
                 "triagePrompt","followUpPrompt","callPrepPrompt"];
let mod;
try {
  mod = new Function("React", code + `\nreturn {${EXPORTS.join(",")}};`)(React);
} catch (e) {
  console.error("FAIL: module did not evaluate\n" + e.stack);
  process.exit(1);
}
console.log("PASS  module evaluates");

// ── assertions ────────────────────────────────────────────────────────────
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { console.error(`FAIL  ${name}${detail ? " — " + detail : ""}`); failed++; }
}

const { businessDaysSince, parseCSV, extractJSON, extractBody, buildRaw,
        decodeB64Url, CAT, CATEGORY_KEYS, App, MODEL } = mod;

// --- businessDaysSince ---
// Anchor on a known Friday so the assertions don't depend on today's date.
const friday = new Date(2026, 0, 2);            // 2 Jan 2026
check("anchor date is a Friday", friday.getDay() === 5, `got day ${friday.getDay()}`);
const at = (d) => new Date(2026, 0, 2 + d);
check("Fri->Sat = 0 business days", businessDaysSince(friday.toISOString(), at(1)) === 0,
      String(businessDaysSince(friday.toISOString(), at(1))));
check("Fri->Sun = 0 business days", businessDaysSince(friday.toISOString(), at(2)) === 0,
      String(businessDaysSince(friday.toISOString(), at(2))));
check("Fri->Mon = 1 business day",  businessDaysSince(friday.toISOString(), at(3)) === 1,
      String(businessDaysSince(friday.toISOString(), at(3))));
check("Fri->next Fri = 5 business days", businessDaysSince(friday.toISOString(), at(7)) === 5,
      String(businessDaysSince(friday.toISOString(), at(7))));
check("same day = 0", businessDaysSince(friday.toISOString(), friday) === 0);
check("missing date = 0", businessDaysSince(null) === 0 && businessDaysSince("nonsense") === 0);
// The headline behaviour: a Friday send at threshold 5 is NOT due the following Wednesday,
// but IS due the following Friday.
check("Fri send not due on Wed (5d threshold)", businessDaysSince(friday.toISOString(), at(5)) < 5);
check("Fri send due on next Fri (5d threshold)", businessDaysSince(friday.toISOString(), at(7)) >= 5);

// --- parseCSV: quoted fields containing commas (the bug in the old parser) ---
const csv = [
  'name,email,company,notes',
  '"Smith, Jane",jane@acme.com,"Acme, Inc.","Met at SaaS Summit, uses HubSpot"',
  'Bob Lee,bob@co.io,CoIO,',
  ',missing@name.com,X,',                       // dropped: no name
].join("\n");
const rows = parseCSV(csv);
check("parseCSV keeps only complete rows", rows.length === 2, `got ${rows.length}`);
check("parseCSV handles quoted comma in name", rows[0].name === "Smith, Jane", rows[0].name);
check("parseCSV handles quoted comma in company", rows[0].company === "Acme, Inc.", rows[0].company);
check("parseCSV handles quoted comma in notes",
      rows[0].notes === "Met at SaaS Summit, uses HubSpot", rows[0].notes);
check("parseCSV maps plain row", rows[1].email === "bob@co.io", rows[1].email);
check("parseCSV assigns ids", !!rows[0].id && rows[0].id !== rows[1].id);
check("parseCSV escaped quotes", parseCSV('name,email\n"He said ""hi""",a@b.c')[0].name === 'He said "hi"');

// --- extractJSON: tolerate fences and preamble ---
check("extractJSON plain", extractJSON('{"a":1}').a === 1);
check("extractJSON fenced", extractJSON('```json\n{"a":2}\n```').a === 2);
check("extractJSON with preamble",
      extractJSON('Here is the JSON:\n```json\n{"a":3}\n```\nHope that helps!').a === 3);
check("extractJSON array", Array.isArray(extractJSON('[{"n":1}]')));
check("extractJSON trailing prose", extractJSON('{"category":"Interested","summary":"x"} — done').category === "Interested");

// --- extractBody: nested MIME + quoted-original stripping ---
const b64 = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_");
const payload = {
  mimeType: "multipart/alternative",
  parts: [
    { mimeType: "text/plain", body: { data: b64("Yes — interested.\n\nOn Mon, Bob wrote:\n> old quoted text") } },
    { mimeType: "text/html",  body: { data: b64("<p>Yes &mdash; interested.</p>") } },
  ],
};
check("extractBody prefers text/plain", extractBody(payload) === "Yes — interested.", JSON.stringify(extractBody(payload)));
check("extractBody strips quoted original", !extractBody(payload).includes("old quoted text"));
const htmlOnly = { mimeType:"text/html", body:{ data: b64("<p>Hi &amp; hello</p><br>line2") } };
check("extractBody falls back to HTML", /Hi & hello/.test(extractBody(htmlOnly)), extractBody(htmlOnly));
check("extractBody handles empty payload", extractBody(null) === "" && extractBody({}) === "");
check("decodeB64Url round-trips UTF-8", decodeB64Url(b64("café — ✓")) === "café — ✓");

// --- buildRaw: headers + threading ---
const raw = buildRaw("me@x.com","you@y.com","Re: Hi","Body here",{"In-Reply-To":"<abc@mail>","References":"<abc@mail>"});
const decoded = Buffer.from(raw.replace(/-/g,"+").replace(/_/g,"/"), "base64").toString("utf8");
check("buildRaw sets To/From/Subject",
      /From: me@x\.com/.test(decoded) && /To: you@y\.com/.test(decoded) && /Subject: Re: Hi/.test(decoded));
check("buildRaw includes In-Reply-To", /In-Reply-To: <abc@mail>/.test(decoded));
check("buildRaw includes References", /References: <abc@mail>/.test(decoded));
check("buildRaw blank line before body", /\r\n\r\nBody here$/.test(decoded));
check("buildRaw is base64url (no + / =)", !/[+/=]/.test(raw));
const rawNoHeaders = buildRaw("a@b","c@d","S","B");
check("buildRaw omits absent optional headers", !/In-Reply-To/.test(
      Buffer.from(rawNoHeaders.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8")));

// --- triage category wiring ---
check("8 categories defined", CATEGORY_KEYS.length === 8, String(CATEGORY_KEYS.length));
const expectStop = ["Unsubscribe","Not Interested","Wrong Person","Referral"];
const expectGo   = ["Interested","Question","Auto-Reply","Other"];
expectStop.forEach(k => check(`"${k}" halts follow-ups`, CAT[k] && CAT[k].stop === true));
expectGo.forEach(k   => check(`"${k}" does not halt follow-ups`, CAT[k] && CAT[k].stop === false));
check("Interested sorts first", Math.min(...CATEGORIES_ranks()) === CAT["Interested"].rank);
function CATEGORIES_ranks(){ return CATEGORY_KEYS.map(k=>CAT[k].rank); }
check("every category has a colour pair", CATEGORY_KEYS.every(k => CAT[k].bg && CAT[k].fg));

// --- misc ---
check("model id is a known-valid string", MODEL === "claude-sonnet-4-6", MODEL);
check("App is a component", typeof App === "function");
check("localStorage keys unchanged (back-compat)",
      /eob_apiKey|eob_clientId|eob_campaign|eob_contacts|eob_sentHistory|eob_userEmail/.test(html));
check("gmail.readonly scope still requested", html.includes("auth/gmail.readonly"));
check("gmail.send scope still requested", html.includes("auth/gmail.send"));
check("browser-direct Anthropic header retained", html.includes("anthropic-dangerous-direct-browser-access"));
check("no build step introduced (CDN React retained)", html.includes("unpkg.com/react@18"));
check("sentHistory is actually written", /setSentHistory\(prev\s*=>\s*\[\.\.\.prev/.test(html));

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
