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
  $("nav-servers").classList.remove("active");
  $("nav-desktops").classList.add("active");
  $("desktop-title").scrollIntoView({ block: "nearest" });
};
$("nav-servers").onclick = () => {
  $("nav-desktops").classList.remove("active");
  $("nav-servers").classList.add("active");
  $("server-search").focus();
};
$("connect-server").onclick = () => show("server-dialog");
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
$("nav-settings").onclick = () => {
  const body = utility("الإعدادات والإدارة"),
    links = node("div", undefined, "settings-links");
  for (const [text, url] of [
    ["ربط Cloudflare والنشر", "/settings/cloudflare"],
    ["الموديلات والمهام", "/agents"],
    ["إدارة الأجهزة والنسخ الاحتياطي والمشاركة", "/manage"],
  ]) {
    const a = node("a", text);
    a.href = url;
    links.append(a);
  }
  body.append(
    links,
    node(
      "p",
      "لربط سيرفر: استخدم مستخدم SSH يملك صلاحية الوصول إلى Docker، وتحقق من بصمة المضيف من داخل السيرفر. لا تضع مفاتيحك في المحادثة.",
      "utility-note",
    ),
  );
  for (const server of servers.filter((s) => s.id)) {
    const row = node("div", undefined, "file-row");
    row.append(
      node("span", server.name),
      button("إزالة الربط", async () => {
        try {
          await api(`/api/v1/servers/${server.id}`, "DELETE");
          await refresh();
          close("utility-dialog");
          notice("تمت إزالة الربط.");
        } catch (e) {
          notice(e.message);
        }
      }),
    );
    body.append(row);
  }
};
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
