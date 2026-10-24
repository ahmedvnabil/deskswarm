"use strict";
const $ = (id) => document.getElementById(id);
let servers = [],
  computers = [],
  runs = [],
  selectedId = null,
  selectedServer = "docker",
  loading = false,
  shotAt = 0,
  shotMachine = null,
  connectionToken = "",
  formVersion = 0;
const statusNames = {
  queued: "في الانتظار",
  running: "يعمل",
  stopping: "جاري الإيقاف",
  completed: "مكتمل",
  failed: "تعذّرت المهمة",
  stopped: "متوقف",
  taken_over: "تحكم يدوي",
  interrupted: "انقطع التنفيذ",
};
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
function icon(name) {
  const img = node("img", undefined, "icon");
  img.src = `/static/icons/${name}.svg`;
  img.alt = "";
  return img;
}
function button(text, handler, cls) {
  const b = node("button", text, cls);
  b.type = "button";
  b.onclick = handler;
  return b;
}
function notice(text) {
  $("notice").textContent = text || "";
}
async function api(path, method = "GET", data) {
  const res = await fetch(path, {
    method,
    headers:
      data instanceof FormData
        ? {}
        : data !== undefined
          ? { "content-type": "application/json" }
          : {},
    body:
      data === undefined
        ? undefined
        : data instanceof FormData
          ? data
          : JSON.stringify(data),
  });
  if (res.status === 401) {
    location.href = "/login?next=%2F";
    throw Error("سجّل الدخول للمتابعة");
  }
  const body = await res.json();
  if (!res.ok || !body.ok) throw Error(body.error || "تعذّر تنفيذ الطلب");
  return body.data;
}
const current = () => computers.find((c) => c.id === selectedId);
const currentRun = () =>
  runs.find((r) => r.computer_id === selectedId && r.lease) ||
  runs.find((r) => r.computer_id === selectedId);
const when = (value) =>
  value
    ? new Intl.DateTimeFormat("ar", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Dubai",
      }).format(new Date(value))
    : "—";
function show(id) {
  $(id).showModal();
}
function close(id) {
  $(id).close();
}
for (const b of document.querySelectorAll("[data-close]"))
  b.onclick = () => close(b.dataset.close);
for (const d of document.querySelectorAll("dialog"))
  d.addEventListener("click", (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d.close();
    }
  });
function tree() {
  const query = $("server-search").value.trim().toLowerCase();
  const groups = [];
  for (const server of servers) {
    const children = computers.filter((c) => c.provider === server.provider);
    if (
      query &&
      !server.name.toLowerCase().includes(query) &&
      !children.some((c) => c.name.toLowerCase().includes(query))
    )
      continue;
    const group = node("div", undefined, "server-group");
    const b = button(
      "",
      () => {
        notice("");
        selectedServer = server.provider;
        selectedId = children[0]?.id || null;
        shotMachine = null;
        tree();
        detail();
      },
      "server-row" + (server.provider === selectedServer ? " selected" : ""),
    );
    b.prepend(icon("chevron-down"), icon("server"));
    const label = node("span", server.name, "server-label");
    label.dir = "ltr";
    b.append(
      label,
      node(
        "span",
        `${children.length} ${children.length === 1 ? "جهاز" : "أجهزة"}`,
        "server-count",
      ),
    );
    b.setAttribute("aria-label", `السيرفر ${server.name}`);
    group.append(b);
    for (const comp of children.filter(
      (c) =>
        !query ||
        server.name.toLowerCase().includes(query) ||
        c.name.toLowerCase().includes(query),
    )) {
      const state = comp.agent_run_id
        ? "Agent يعمل"
        : comp.sleeping
          ? "نائم"
          : !comp.control_ok
            ? "غير متصل"
            : comp.reserved
              ? "تحكم يدوي"
              : "متاح";
      const row = button(
        "",
        () => {
          notice("");
          selectedId = comp.id;
          selectedServer = comp.provider;
          shotMachine = null;
          tree();
          detail();
        },
        "machine-row" + (comp.id === selectedId ? " selected" : ""),
      );
      row.setAttribute("aria-label", `الجهاز ${comp.name}`);
      row.append(
        icon("device-desktop"),
        node("span", comp.name, "machine-name"),
        node(
          "span",
          state,
          "machine-state" + (!comp.control_ok ? " offline" : ""),
        ),
      );
      group.append(row);
    }
    if (!children.length)
      group.append(node("p", "لا توجد أجهزة بعد", "muted sidebar-note"));
    if (server.status === "unreachable")
      group.append(node("p", "تعذّر الاتصال بالسيرفر", "muted sidebar-note"));
    groups.push(group);
  }
  if (!groups.length) groups.push(node("p", "لا توجد نتائج مطابقة", "muted"));
  $("server-tree").replaceChildren(...groups);
}
function detail() {
  const comp = current(),
    job = currentRun();
  $("empty-screen").classList.toggle("hidden", !!comp);
  $("desktop-screen").classList.toggle("hidden", !comp || comp.sleeping);
  $("open-desktop").classList.toggle("disabled", !comp || comp.sleeping);
  $("files-open").disabled = !comp;
  $("shell-open").disabled = !comp || !!comp.agent_run_id;
  $("wake-desktop").classList.toggle("hidden", !comp?.sleeping);
  $("refresh-desktop").disabled = !comp || comp.sleeping;
  $("desktop-status").classList.toggle("hidden", !comp);
  if (!comp) {
    $("desktop-title").textContent = "اختر جهازًا";
    $("desktop-meta").textContent = "";
    $("agent-state").textContent = "لا توجد مهمة جارية";
    $("agent-time").textContent = "—";
    $("agent-task").textContent = "";
    $("activity").replaceChildren();
    $("run-agent").disabled = true;
    $("take-control").disabled = true;
    $("download-result").classList.add("disabled");
    $("download-result").removeAttribute("href");
    $("open-desktop").removeAttribute("href");
    $("stop-agent").classList.add("hidden");
    $("release-control").classList.add("hidden");
    return;
  }
  const server = servers.find((s) => s.provider === comp.provider);
  $("desktop-title").textContent = `${server?.name || "Server"} / ${comp.name}`;
  $("desktop-meta").textContent = `${server?.host || "Local"} · XFCE · Linux`;
  $("desktop-status").textContent = comp.agent_run_id
    ? "Agent يعمل"
    : comp.sleeping
      ? "نائم"
      : comp.reserved
        ? "تحكم يدوي"
        : comp.control_ok
          ? "متاح"
          : "غير متصل";
  $("desktop-status").classList.toggle("down", !comp.control_ok);
  if (comp.sleeping) $("open-desktop").removeAttribute("href");
  else $("open-desktop").href = comp.novnc_url || "#";
  $("open-desktop").lastChild.textContent = comp.agent_run_id
    ? "مشاهدة الشاشة"
    : "فتح الشاشة";
  $("screen-caption").textContent = comp.agent_run_id
    ? "مشاهدة فقط أثناء تنفيذ الـAgent"
    : "معاينة الشاشة تُحدّث تلقائيًا";
  if (
    !comp.sleeping &&
    (shotMachine !== comp.id || Date.now() - shotAt > 6000)
  ) {
    shotAt = Date.now();
    shotMachine = comp.id;
    $("desktop-screen").src =
      `/api/v1/computers/${comp.id}/screenshot?t=${shotAt}`;
  }
  if (!job) $("activity").replaceChildren();
  $("agent-state").textContent = job?.lease
    ? statusNames[job.status] || job.status
    : comp.reserved
      ? "تحكم يدوي"
      : "متاح";
  $("agent-time").textContent = when(job?.updated_at);
  $("agent-task").textContent = job?.summary || job?.error || job?.task || "";
  $("run-agent").disabled = !!comp.agent_run_id || comp.reserved;
  $("take-control").disabled = !job?.lease || job.status === "stopping";
  $("stop-agent").disabled = !job?.lease || job.status === "stopping";
  $("stop-agent").classList.toggle("hidden", !job?.lease);
  $("download-result").classList.toggle("disabled", !job || !!job.lease);
  if (job && !job.lease)
    $("download-result").href = `/api/v1/agents/runs/${job.id}/result`;
  else $("download-result").removeAttribute("href");
  $("release-control").classList.toggle("hidden", !comp.reserved);
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const result = await Promise.all([
      api("/api/v1/servers"),
      api("/api/v1/computers"),
      api("/api/v1/agents/runs"),
    ]);
    [servers, computers, runs] = result;
    if (!servers.some((s) => s.provider === selectedServer))
      selectedServer = "docker";
    if (
      !computers.some(
        (c) => c.id === selectedId && c.provider === selectedServer,
      )
    )
      selectedId =
        computers.find((c) => c.provider === selectedServer)?.id || null;
    tree();
    detail();
    const job = currentRun();
    if (job) {
      const run = await api(`/api/v1/agents/runs/${job.id}`);
      if (job.id === currentRun()?.id)
        $("activity").replaceChildren(
          ...run.events.slice(-3).map((e) =>
            node(
              "p",
              {
                queued: "تم قبول المهمة",
                started: "بدأ التنفيذ على الجهاز",
                tool: "جارٍ تنفيذ خطوة",
                tool_done: "اكتملت خطوة",
                tool_error: "تعذّرت خطوة؛ راجع المهمة",
                completed: "اكتملت المهمة والنتائج جاهزة",
                stop: "طُلب إيقاف التنفيذ",
                failed: "توقفت المهمة بسبب خطأ",
              }[e.kind] || e.message,
            ),
          ),
        );
    }
  } catch (e) {
    notice(e.message);
  } finally {
    loading = false;
  }
}
$("desktop-screen").onerror = () => {
  $("screen-caption").textContent =
    "تعذّرت معاينة الشاشة. جرّب تحديثها أو فحص السيرفر.";
};
$("server-search").oninput = tree;
$("refresh-desktop").onclick = () => {
  shotMachine = null;
  detail();
};
$("nav-desktops").onclick = () => {
  closePanel();
  $("desktop-title").scrollIntoView({ block: "nearest" });
};
$("nav-servers").onclick = () => openPanel("/settings/connections", "nav-servers");
$("nav-agents").onclick = e => { e.preventDefault(); openPanel("/agents", "nav-agents"); };
$("connect-server").onclick = async () => {
  try {
    const settings = await api("/api/v1/connections/status");
    const form = $("server-form");
    form.elements.username.value = settings.preferences.ssh_user;
    form.elements.port.value = settings.preferences.ssh_port;
  } catch {}
  show("server-dialog");
};
$("server-dialog").addEventListener("close", () => {
  $("server-form").reset();
  connectionToken = "";
  formVersion++;
  $("save-server").disabled = true;
  $("connection-message").textContent = "";
});
function changedConnection() {
  formVersion++;
  connectionToken = "";
  $("save-server").disabled = true;
  $("connection-message").textContent = "";
}
$("server-form").addEventListener("input", changedConnection);
$("ssh-key-file").addEventListener("change", changedConnection);
async function connectionData() {
  const form = $("server-form"),
    file = form.elements.key_file.files[0];
  if (!file || file.size > 65536)
    throw Error("اختر ملف مفتاح SSH بحجم لا يتجاوز 64 KB");
  return {
    name: form.elements.name.value,
    host: form.elements.host.value,
    username: form.elements.username.value,
    port: Number(form.elements.port.value),
    fingerprint: form.elements.fingerprint.value,
    private_key: await file.text(),
    passphrase: form.elements.passphrase.value,
  };
}
$("server-form").onsubmit = async (e) => {
  e.preventDefault();
  const version = formVersion;
  $("test-connection").disabled = true;
  $("connection-message").textContent =
    "جاري التحقق من SSH والبصمة والوصول إلى Docker…";
  try {
    const config = await connectionData();
    const response = await api("/api/v1/servers/test", "POST", config);
    if (version !== formVersion) return;
    connectionToken = response.test_token;
    $("save-server").disabled = false;
    $("connection-message").textContent =
      `الاتصال ناجح · Docker ${response.info.version} · ${response.info.architecture} · يمكنك حفظ السيرفر الآن.`;
  } catch (error) {
    if (version === formVersion)
      $("connection-message").textContent = error.message;
  } finally {
    $("test-connection").disabled = false;
  }
};
$("save-server").onclick = async () => {
  if (!connectionToken) return;
  const version = formVersion;
  $("save-server").disabled = true;
  try {
    const config = await connectionData();
    if (version !== formVersion)
      throw Error("تغيّرت الإعدادات؛ اختبر الاتصال مجددًا");
    const row = await api("/api/v1/servers", "POST", {
      ...config,
      test_token: connectionToken,
    });
    selectedServer = row.provider;
    close("server-dialog");
    await refresh();
    notice(`تم ربط ${row.name}. يمكنك إنشاء جهاز على السيرفر.`);
  } catch (error) {
    $("connection-message").textContent = error.message;
  }
};
function createDesktop() {
  const options = servers.map((s) => {
    const o = node("option", s.name);
    o.value = s.id;
    return o;
  });
  $("create-server").replaceChildren(...options);
  const server = servers.find((s) => s.provider === selectedServer);
  $("create-server").value = server?.id || 0;
  $("create-message").textContent = "";
  show("create-dialog");
}
$("new-desktop").onclick = createDesktop;
$("empty-create").onclick = createDesktop;
$("create-form").onsubmit = async (e) => {
  e.preventDefault();
  $("create-submit").disabled = true;
  $("create-message").textContent =
    "جاري تجهيز الجهاز. قد يستغرق بناء الصورة الأولى عدة دقائق…";
  try {
    const response = await api("/api/v1/computers", "POST", {
      name: $("create-name").value,
      server_id: Number($("create-server").value),
    });
    const comp = response.computers?.[0] || response;
    selectedId = comp.id;
    selectedServer = comp.provider;
    close("create-dialog");
    $("create-form").reset();
    await refresh();
    notice("تم إنشاء الجهاز. انتظر حتى تصبح شاشة Linux جاهزة.");
  } catch (error) {
    $("create-message").textContent = error.message;
  } finally {
    $("create-submit").disabled = false;
  }
};
$("run-agent").onclick = async () => {
  if (!current()) return;
  $("agent-message").textContent = "";
  try {
    const models = await api("/api/v1/agents/models");
    if (!models.length) {
      notice("أضف اتصال موديل من صفحة Agents أولًا.");
      location.href = "/agents";
      return;
    }
    $("agent-model").replaceChildren(
      ...models.map((m) => {
        const o = node("option", m.name);
        o.value = m.id;
        return o;
      }),
    );
    $("agent-target").textContent = `الجهاز: ${current().name}`;
    show("agent-dialog");
  } catch (e) {
    notice(e.message);
  }
};
$("agent-form").onsubmit = async (e) => {
  e.preventDefault();
  $("agent-submit").disabled = true;
  try {
    await api("/api/v1/agents/runs", "POST", {
      computer_id: selectedId,
      model_id: Number($("agent-model").value),
      task: $("agent-instruction").value,
    });
    close("agent-dialog");
    await refresh();
    notice("بدأت المهمة. يمكنك مشاهدتها أو استلام التحكم.");
  } catch (error) {
    $("agent-message").textContent = error.message;
  } finally {
    $("agent-submit").disabled = false;
  }
};
async function agentAction(action) {
  const job = currentRun();
  if (!job?.lease) return;
  try {
    await api(`/api/v1/agents/runs/${job.id}/${action}`, "POST", {});
    notice(
      action === "takeover"
        ? "جاري تسليم التحكم بعد توقف العملية الجارية…"
        : "جاري إيقاف المهمة…",
    );
    await refresh();
  } catch (error) {
    notice(error.message);
  }
}
$("take-control").onclick = () => agentAction("takeover");
$("stop-agent").onclick = () => agentAction("stop");
$("release-control").onclick = async () => {
  try {
    await api(`/api/v1/computers/${selectedId}`, "PATCH", { reserved: false });
    await refresh();
    notice("تم تحرير الجهاز لمهمة جديدة.");
  } catch (e) {
    notice(e.message);
  }
};
$("wake-desktop").onclick = async () => {
  try {
    await api(`/api/v1/computers/${selectedId}/wake`, "POST", {});
    await refresh();
  } catch (e) {
    notice(e.message);
  }
};
$("check-server").onclick = async () => {
  const server = servers.find((s) => s.provider === selectedServer);
  if (!server) return;
  try {
    if (server.id) await api(`/api/v1/servers/${server.id}/test`, "POST", {});
    else
      await fetch("/health").then((r) => {
        if (!r.ok) throw Error("تعذّر الاتصال المحلي");
      });
    await refresh();
    notice("الاتصال بالسيرفر يعمل.");
  } catch (e) {
    notice(e.message);
    await refresh();
  }
};
function utility(title) {
  $("utility-title").textContent = title;
  $("utility-body").replaceChildren();
  show("utility-dialog");
  return $("utility-body");
}
$("shell-open").onclick = () => {
  const comp = current();
  if (!comp) return;
  const body = utility(`الأوامر — ${comp.name}`),
    form = node("form"),
    label = node("label", "الأمر داخل جهاز Linux"),
    input = node("textarea"),
    output = node("pre", "", "output"),
    submit = node("button", "تنفيذ", "primary");
  input.dir = "ltr";
  input.required = true;
  label.append(input);
  form.append(label, submit);
  body.append(
    node("p", "تعمل الأوامر بصلاحيات إدارة داخل حاوية الجهاز.", "utility-note"),
    form,
    output,
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const result = await api(`/api/v1/computers/${comp.id}/exec`, "POST", {
        command: input.value,
      });
      output.textContent = result.output || JSON.stringify(result);
    } catch (error) {
      output.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
};
async function showFiles(comp, path = "") {
  const body = $("utility-body");
  body.replaceChildren(node("p", "جاري تحميل الملفات…", "muted"));
  try {
    const data = await api(
      `/api/v1/computers/${comp.id}/files?path=${encodeURIComponent(path)}`,
    );
    body.replaceChildren(node("p", path || "/home/cua", "mono muted"));
    if (path)
      body.append(
        button("المجلد الأب", () =>
          showFiles(comp, path.split("/").slice(0, -1).join("/")),
        ),
      );
    for (const file of data.entries) {
      const rel = path ? `${path}/${file.name}` : file.name,
        row = node("div", undefined, "file-row");
      row.append(
        icon(file.type === "dir" ? "folder" : "download"),
        node("span", file.name, "mono"),
      );
      if (file.type === "dir")
        row.append(button("فتح", () => showFiles(comp, rel)));
      else {
        const link = node("a", "تنزيل");
        link.href = `/api/v1/computers/${comp.id}/files/download?path=${encodeURIComponent(rel)}`;
        row.append(link);
      }
      body.append(row);
    }
    if (!data.entries.length) body.append(node("p", "المجلد فارغ", "muted"));
    const form = node("form"),
      label = node("label", "رفع ملف هنا"),
      upload = node("input");
    upload.type = "file";
    upload.required = true;
    label.append(upload);
    const submit = node("button", "رفع الملف", "primary"),
      message = node("p", "", "muted");
    form.append(label, submit, message);
    body.append(form);
    form.onsubmit = async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        const payload = new FormData();
        payload.set("file", upload.files[0]);
        payload.set("path", path || ".");
        await api(`/api/v1/computers/${comp.id}/files`, "POST", payload);
        await showFiles(comp, path);
      } catch (error) {
        message.textContent = error.message;
        submit.disabled = false;
      }
    };
  } catch (error) {
    body.replaceChildren(node("p", error.message, "muted"));
  }
}
$("files-open").onclick = () => {
  const comp = current();
  if (!comp) return;
  utility(`الملفات — ${comp.name}`);
  showFiles(comp);
};
$("nav-settings").onclick = () => openPanel("/manage", "nav-settings");
function clock() {
  $("clock").textContent =
    new Intl.DateTimeFormat("ar", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Dubai",
    }).format(new Date()) + " · دبي";
}
clock();
setInterval(clock, 30000);
refresh();
setInterval(refresh, 5000);

// Shared by bookmarked inventory links and the embedded panel bridge.
async function preparePeer(peerId) {
  if (!peerId || peerId.length > 200) return;
  try {
    const [inventory, settings] = await Promise.all([
      api("/api/v1/netbird/peers"), api("/api/v1/connections/status"),
    ]);
    const peer = inventory.peers.find(p => p.id === peerId);
    if (!peer?.connectable) throw Error("الجهاز غير متاح لربط Linux عبر SSH");
    const form = $("server-form");
    form.elements.name.value = peer.name;
    form.elements.host.value = peer.ip;
    form.elements.username.value = settings.preferences.ssh_user;
    form.elements.port.value = settings.preferences.ssh_port;
    changedConnection(); show("server-dialog");
    $("connection-message").textContent = peer.connected
      ? "تم ملء عنوان NetBird. اختر مفتاح SSH وبصمة المضيف واختبر Docker. يجب أن تتمكن خدمة DeskSwarm من الوصول إلى شبكة NetBird."
      : "الجهاز غير متصل حسب آخر مزامنة NetBird. يمكنك تجهيز البيانات الآن ثم اختباره عندما يتصل.";
  } catch (e) { console.warn("NetBird setup unavailable:", e.message); }
}
const initialPeer = new URL(location.href).searchParams.get("connect_peer");
if (initialPeer) preparePeer(initialPeer);

// Each trusted view retains its form draft and scripts; inactive polling pauses.
const panelPaths = new Map([
  ["/agents", {tab:"tab-agents", title:"Agents", nav:"nav-agents"}],
  ["/settings/connections", {tab:"tab-connections",title:"الاتصالات وNetBird",nav:"nav-servers"}],
  ["/settings/cloudflare", {tab:"tab-cloudflare",title:"Cloudflare",nav:"nav-settings"}],
  ["/manage", {tab:"tab-settings",title:"الإعدادات والإدارة",nav:"nav-settings"}],
]);
const panelFrames = new Map();
let activePanel = null;
function fitPanel(frame,height){
  const preview = document.querySelector(".screen-stage").getBoundingClientRect().height;
  const available = Math.max(360,window.innerHeight-57-preview-110);
  frame.style.height = Math.min(available,Math.max(320,height))+"px";
}
addEventListener("resize",()=>{for(const frame of panelFrames.values())fitPanel(frame,Number(frame.dataset.contentHeight)||620)});
function closePanel(){
  for(const frame of panelFrames.values()){frame.hidden=true;frame.contentWindow?.postMessage({type:"deskswarm:panel-active",active:false},location.origin)}
  activePanel=null;document.body.classList.remove("panel-open");$("panel-hint").hidden=false;
  for(const item of panelPaths.values()){$(item.tab).setAttribute("aria-selected","false");$(item.tab).tabIndex=0}
  document.querySelectorAll(".rail-link").forEach(n=>n.classList.toggle("active",n.id==="nav-desktops"));
}
function openPanel(path,nav){
  const info=panelPaths.get(path);if(!info)return;
  activePanel=path;document.body.classList.add("panel-open");$("panel-hint").hidden=true;
  let frame=panelFrames.get(path);
  if(!frame){
    frame=document.createElement("iframe");frame.title=info.title+" — تحت معاينة الجهاز";frame.id="frame-"+info.tab;frame.setAttribute("role","tabpanel");frame.setAttribute("aria-labelledby",info.tab);frame.referrerPolicy="same-origin";frame.style.height="620px";
    const url=new URL(path,location.origin);url.searchParams.set("embedded","1");if(path==="/agents"&&current())url.searchParams.set("computer_id",current().id);
    frame.src=url.pathname+url.search;
    frame.onload=()=>frame.contentWindow?.postMessage({type:"deskswarm:panel-active",active:activePanel===path},location.origin);
    panelFrames.set(path,frame);$("panel-frames").append(frame);
  }
  for(const [key,view]of panelFrames){view.hidden=key!==path;view.contentWindow?.postMessage({type:"deskswarm:panel-active",active:key===path},location.origin)}
  for(const [key,item]of panelPaths){$(item.tab).setAttribute("aria-selected",String(key===path));$(item.tab).tabIndex=key===path?0:-1;$(item.tab).setAttribute("aria-controls","frame-"+item.tab)}
  document.querySelectorAll(".rail-link").forEach(n=>n.classList.toggle("active",n.id===(nav||info.nav)));
  $("workbench").scrollIntoView({block:"nearest",behavior:"smooth"});
}
$("panel-collapse").onclick=closePanel;
for(const [path,info]of panelPaths){$(info.tab).onclick=()=>openPanel(path);$(info.tab).onkeydown=e=>{const keys=Array.from(panelPaths.keys());let i=keys.indexOf(path);if(e.key==="ArrowLeft")i=(i+1)%keys.length;else if(e.key==="ArrowRight")i=(i+keys.length-1)%keys.length;else if(e.key==="Home")i=0;else if(e.key==="End")i=keys.length-1;else return;e.preventDefault();openPanel(keys[i]);$(panelPaths.get(keys[i]).tab).focus()}}
document.addEventListener("click",e=>{
  const link=e.target.closest?.("a[href]");if(!link||e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
  const url=new URL(link.href,location.href);if(url.origin!==location.origin)return;
  if(url.pathname==="/"&&!url.search){e.preventDefault();closePanel();$("desktop-title").scrollIntoView({block:"nearest"});return}
  if(!panelPaths.has(url.pathname))return;
  e.preventDefault();openPanel(url.pathname);
});
async function focusComputerFromPanel(value) {
  const id=Number(value);if(!Number.isSafeInteger(id)||id<1)return;
  try {
    const result=await Promise.all([api("/api/v1/servers"),api("/api/v1/computers")]);
    const comp=result[1].find(c=>c.id===id);
    if(!comp){notice("الجهاز غير متاح؛ حدّث قائمة الأجهزة");return;}
    [servers,computers]=result;selectedId=comp.id;selectedServer=comp.provider;shotMachine=null;
    closePanel();tree();detail();$("desktop-title").scrollIntoView({block:"nearest"});
  } catch { notice("تعذّر تحميل الجهاز؛ أعد المحاولة"); }
}
addEventListener("message",e=>{
  if(e.origin!==location.origin)return;
  const entry=Array.from(panelFrames.entries()).find(([,frame])=>frame.contentWindow===e.source);if(!entry)return;
  if(e.data?.type==="deskswarm:panel-height"&&entry[0]===activePanel){const height=Number(e.data.height);if(Number.isFinite(height)&&height>0){entry[1].dataset.contentHeight=String(height);fitPanel(entry[1],height)}}
  if(e.data?.type!=="deskswarm:navigate"||typeof e.data.path!=="string")return;
  const url=new URL(e.data.path,location.origin);if(url.origin!==location.origin)return;
  if(panelPaths.has(url.pathname))openPanel(url.pathname);
  else if(url.pathname==="/"){const peer=url.searchParams.get("connect_peer");if(peer)preparePeer(peer);else if(url.searchParams.has("connect_server"))$("connect-server").click();else if(url.searchParams.has("computer_id"))void focusComputerFromPanel(url.searchParams.get("computer_id"));else closePanel()}
});
const initialPanel=document.body.dataset.initialPanel;
if(panelPaths.has(initialPanel))openPanel(initialPanel);

if(new URL(location.href).searchParams.has("connect_server"))$("connect-server").click();
