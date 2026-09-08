// Mounts the real <App/> in jsdom, drives it through the real Google-auth code path
// with a stubbed GIS client, and visits every tab to catch render-time crashes.
const fs = require("fs");
const path = require("path");
const Babel = require("@babel/standalone");
const { JSDOM } = require("jsdom");

const HTML = path.join(__dirname, "../index.html");
const src = fs.readFileSync(HTML, "utf8")
  .match(/<script type="text\/babel">([\s\S]*?)<\/script>/)[1]
  .replace(/ReactDOM\.createRoot\([\s\S]*?\);\s*$/, "");
const code = Babel.transform(src, { presets: [["react", { runtime: "classic" }]] }).code;

const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 864e5).toISOString();
const seed = {
  eob_apiKey: JSON.stringify("sk-ant-test"),
  eob_clientId: JSON.stringify("123.apps.googleusercontent.com"),
  eob_userEmail: JSON.stringify("me@milstudio.com"),
  eob_campaign: JSON.stringify({senderName:"Luke",product:"Web design",tone:"Friendly",subjectHint:"",followUpDays:5}),
  eob_contacts: JSON.stringify([{id:"c1",name:"Jane Smith",email:"jane@acme.com",company:"Acme",jobTitle:"Head of Marketing",linkedIn:"",notes:"met at summit"}]),
  eob_sentHistory: JSON.stringify([
    {id:"r1",contact:{id:"c1",name:"Jane Smith",email:"jane@acme.com",company:"Acme"},
     subject:"Quick question",body:"Hi Jane...",sentAt:iso(20),lastContactedAt:iso(20),
     threadId:"t1",status:"sent",followUpCount:0,followUps:[],doNotContact:false,reply:null,triage:null},
    {id:"r2",contact:{id:"c2",name:"Bob Lee",email:"bob@co.io",company:"CoIO"},
     subject:"Idea for CoIO",body:"Hi Bob...",sentAt:iso(9),lastContactedAt:iso(9),
     threadId:"t2",status:"replied",followUpCount:1,followUps:[],doNotContact:false,
     reply:{snippet:"Sounds good",bodyText:"Sounds good, send pricing",from:"bob@co.io",receivedAt:iso(2),messageCount:2},
     triage:{category:"Interested",summary:"Wants pricing",triagedAt:iso(2)}},
    {id:"r3",contact:{id:"c3",name:"Ann Kim",email:"ann@x.com",company:"X"},
     subject:"Hello",body:"Hi Ann...",sentAt:iso(30),lastContactedAt:iso(30),
     threadId:"t3",status:"replied",followUpCount:0,followUps:[],doNotContact:true,
     reply:{snippet:"remove me",bodyText:"Please remove me",from:"ann@x.com",receivedAt:iso(25),messageCount:2},
     triage:{category:"Unsubscribe",summary:"Asked to be removed",triagedAt:iso(25)}},
    {id:"r4",contact:{id:"c4",name:"Dan Fox",email:"bad@@addr",company:""},
     subject:"Hi",body:"...",sentAt:iso(3),lastContactedAt:iso(3),
     threadId:null,status:"error",errorMessage:"Invalid to header",
     followUpCount:0,followUps:[],doNotContact:false,reply:null,triage:null},
  ]),
};

const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`,
  { url: "https://milboiz.github.io/Email-Bot/", pretendToBeVisual: true });
const { window } = dom;
Object.entries(seed).forEach(([k,v]) => window.localStorage.setItem(k,v));

global.IS_REACT_ACT_ENVIRONMENT = true;   // makes act() authoritative; silences the env warning
global.window = window;
global.document = window.document;
global.navigator = window.navigator;
global.localStorage = window.localStorage;
global.TextEncoder = TextEncoder; global.TextDecoder = TextDecoder;
global.btoa = (s)=>Buffer.from(s,"binary").toString("base64");
global.atob = (s)=>Buffer.from(s,"base64").toString("binary");
global.alert = () => {};
global.Notification = undefined;

const calls = [];
global.fetch = (url) => {
  calls.push(String(url));
  const u = String(url);
  const json = (o) => Promise.resolve({ ok:true, json: () => Promise.resolve(o) });
  if (u.includes("oauth2/v3/userinfo")) return json({ email:"me@milstudio.com", name:"Luke" });
  // Threads with no inbound reply -> polling finds nothing, leaves records untouched.
  if (u.includes("gmail/v1/users/me/threads")) return json({ messages:[{ payload:{headers:[{name:"From",value:"me@milstudio.com"}]}, snippet:"" }] });
  return Promise.reject(new Error("unexpected network call: " + u));
};

// Stub Google Identity Services: fire the callback synchronously with a token,
// exercising the app's real onAuthSuccess path.
window.google = { accounts: { oauth2: { initTokenClient: (cfg) => ({
  requestAccessToken: () => cfg.callback({ access_token: "ya29.fake-token" }),
})}}};

const React = require("react");
const ReactDOM = require("react-dom/client");
const { act } = require("react");

const errors = [];
const origError = console.error, origWarn = console.warn;
console.error = (...a) => { errors.push(a.join(" ")); };
console.warn  = (...a) => { errors.push(a.join(" ")); };

const { App } = new Function("React", code + "\nreturn {App};")(React);

let failed = 0;
const check = (n, c, d) => c ? console.log(`PASS  ${n}`)
                             : (console.error(`FAIL  ${n}${d?" — "+d:""}`), failed++, origError(`FAIL  ${n}${d?" — "+d:""}`));

const container = window.document.getElementById("root");
let root;
const text = () => container.textContent;
const tabButtons = () => Array.from(container.querySelectorAll(".tab"));
const clickTab = (label) => {
  const b = tabButtons().find(x => x.textContent.startsWith(label));
  if (!b) throw new Error(`tab "${label}" not found; have: ${tabButtons().map(t=>t.textContent).join("|")}`);
  act(() => { b.dispatchEvent(new window.MouseEvent("click", {bubbles:true})); });
};

(async () => {
  await act(async () => {
    root = ReactDOM.createRoot(container);
    root.render(React.createElement(App));
  });

  // The silent-reconnect effect should have authorised us and landed on Follow-ups.
  check("silent reconnect authorised the session", tabButtons().length === 7,
        `${tabButtons().length} tabs`);
  check("userinfo was fetched", calls.some(c=>c.includes("userinfo")));
  check("landed on Follow-ups (history exists)", /Gone quiet/.test(text()));

  // Follow-ups tab
  check("follow-up surfaces the quiet contact", /Jane Smith/.test(text()));
  check("follow-up excludes unsubscribed contact", !/Ann Kim/.test(text()));
  check("follow-up excludes replied contact", !/Bob Lee/.test(text()));
  check("follow-up shows day count", /\d+d quiet/.test(text()));
  check("follow-up threshold copy present", /business days/.test(text()));

  clickTab("Replies");
  check("replies tab renders", /Inbox triage/.test(text()));
  check("replies shows Interested tag", /Interested/.test(text()));
  check("replies shows triage summary", /Wants pricing/.test(text()));
  check("replies shows unsubscribed contact", /Ann Kim/.test(text()));
  check("replies marks follow-ups stopped", /Follow-ups stopped/.test(text()));
  const order = text().indexOf("Bob Lee") < text().indexOf("Ann Kim");
  check("Interested sorts above Unsubscribe", order);

  clickTab("Sent");
  check("sent dashboard renders", /Reply rate/.test(text()));
  check("sent shows failed send", /Invalid to header/.test(text()));
  check("sent surfaces error count", /failed to send/.test(text()));
  check("sent shows follow-up count", /1 follow-up/.test(text()));

  clickTab("Call Prep");
  check("call prep renders", /Call prep brief/.test(text()));
  check("call prep lists contacts", /Jane Smith/.test(text()));

  clickTab("Contacts");
  check("contacts tab renders", /Import contacts/.test(text()));

  clickTab("Emails");
  check("emails tab empty state", /No drafts in progress/.test(text()));

  clickTab("Campaign");
  check("campaign tab renders", /Campaign settings/.test(text()));
  check("campaign exposes follow-up threshold", /Follow-up nudges/.test(text()));
  const numInput = container.querySelector('input[type="number"]');
  check("threshold input is populated", numInput && numInput.value === "5", numInput && numInput.value);

  await act(async () => { root.unmount(); });

  const real = errors.filter(e => !/not wrapped in act|not configured to support act/i.test(e));
  check("no React errors or warnings", real.length === 0, real[0]);

  console.error = origError; console.warn = origWarn;
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nRENDER CHECKS PASSED");
  process.exit(failed ? 1 : 0);
})();
