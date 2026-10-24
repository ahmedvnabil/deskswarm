/** Offline-only Cloudflare preparation. Saving never contacts a provider. */
import { getDb, one, run } from "../db";
import { config, initCloudflare } from "./control";
import { nowIso } from "../settings";
export const services = [
  {
    id: "containers",
    name: "بيئة Linux",
    purpose:
      "مكان تنفيذ مستقل للـAgent على Cloudflare؛ صورة سطح المكتب تحتاج اختبارًا سحابيًا.",
    permissions: ["Containers Edit/Write", "Workers Scripts Edit/Write"],
    ready: false,
  },
  {
    id: "browser",
    name: "متصفح سحابي",
    purpose:
      "مهام الويب مع متابعة الجلسة واستلام التحكم؛ ليس سطح مكتب Linux كاملًا.",
    permissions: ["Browser Rendering Edit/Write"],
    ready: false,
  },
  {
    id: "artifacts",
    name: "نتائج المهام — R2",
    purpose:
      "أرشفة ملفات النتائج وبيانات التحقق خارج سيرفر التطبيق. التخزين الحالي يظل محليًا.",
    permissions: ["Workers R2 Storage Edit/Write أو ربط R2 داخل Worker"],
    ready: false,
  },
  {
    id: "tunnel",
    name: "Tunnel وDNS",
    purpose:
      "ربط خدمة Linux بدومين. مسار التجهيز موجود؛ الإنشاء يحتاج الصلاحيات وفحصًا فعليًا.",
    permissions: ["Cloudflare Tunnel Edit/Write", "Zone Read", "DNS Edit"],
    ready: true,
  },
  {
    id: "ai",
    name: "موديلات Workers AI",
    purpose: "ربط موديلات إضافية؛ إتاحة الأدوات والرؤية تُختبر لكل موديل.",
    permissions: ["Workers AI Read", "Workers AI Edit"],
    ready: false,
  },
] as const;
export const defaults = {
  selected: ["containers", "browser", "artifacts"],
  worker_name: "deskswarm-compute",
  bucket_name: "deskswarm-artifacts",
  max_machines: 1,
  idle_minutes: 15,
  browser_minutes: 10,
  retention_days: 30,
  artifact_prefix: "runs",
  ai_model: "",
  default_target: "linux",
};
export function initPreparation() {
  initCloudflare();
  getDb().exec(
    "CREATE TABLE IF NOT EXISTS cloudflare_preparation(id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
}
export function validatePreparation(body: Record<string, unknown>) {
  const selected = body.selected;
  if (
    !Array.isArray(selected) ||
    selected.some((x) => !services.some((s) => s.id === x)) ||
    new Set(selected).size !== selected.length
  )
    throw Error("اختر خدمات صالحة بدون تكرار");
  const name = (key: string) => {
    const v = String(body[key] || "");
    if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(v))
      throw Error(
        "اسم Worker والحاوية من 3 إلى 63 حرفًا صغيرًا أو رقمًا أو شرطة",
      );
    return v;
  };
  const integer = (key: string, min: number, max: number) => {
    const v = Number(body[key]);
    if (!Number.isInteger(v) || v < min || v > max)
      throw Error(`قيمة ${key} خارج الحدود`);
    return v;
  };
  const prefix = String(body.artifact_prefix || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(prefix))
    throw Error("بادئة النتائج غير صالحة");
  if (body.default_target !== "linux")
    throw Error("التشغيل الافتراضي يظل Linux حتى اجتياز الاختبار السحابي");
  const ai = String(body.ai_model || "");
  if (ai.length > 200 || /[\r\n\x00]/.test(ai))
    throw Error("اسم الموديل غير صالح");
  return {
    selected: selected as string[],
    worker_name: name("worker_name"),
    bucket_name: name("bucket_name"),
    max_machines: integer("max_machines", 1, 10),
    idle_minutes: integer("idle_minutes", 1, 60),
    browser_minutes: integer("browser_minutes", 1, 60),
    retention_days: integer("retention_days", 1, 365),
    artifact_prefix: prefix,
    ai_model: ai,
    default_target: "linux",
  };
}
export function suggestedDefaults(){
 const base=String(config()?.worker||"deskswarm").replace(/-(control|gateway|worker)$/," ").trim().slice(0,48)||"deskswarm";
 return {...defaults,worker_name:base+"-compute",bucket_name:base+"-artifacts"};
}
export function preparation() {
  initPreparation();
  const row = one("SELECT * FROM cloudflare_preparation WHERE id=1");
  return {
    settings: row ? JSON.parse(row.settings) : suggestedDefaults(),
    updated_at: row?.updated_at || null,
    mode: "preparation_only",
    remote_verified: false,
    services,
    notes: [
      "حفظ محلي فقط؛ لا تتغير المفاتيح أو الصلاحيات ولا تُنشأ موارد مدفوعة.",
      "حدود التشغيل والاحتفاظ المقترحة لا تُطبق على الأجهزة الحالية.",
      "الرجوع: ألغِ اختيار الخدمات. Linux وProxmox يظلان متاحين.",
    ],
  };
}
export function savePreparation(body: Record<string, unknown>) {
  initPreparation();
  const settings = validatePreparation(body);
  run(
    "INSERT INTO cloudflare_preparation(id,settings,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at",
    JSON.stringify(settings),
    nowIso(),
  );
  return preparation();
}
