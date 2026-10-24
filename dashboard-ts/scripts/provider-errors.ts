/** Fixed, credential-free provider diagnostics shared by private gateways and dashboard. */
export function failureReason(text: string): string {
  if (
    /تسجيل الدخول غير صالح|not logged|unauth|401|expired|invalid.*token|login required/i.test(
      text,
    )
  )
    return "تسجيل الدخول غير صالح أو منتهي. أعد تسجيل الدخول ثم اختبر الاتصال.";
  if (
    /حد الاستخدام|429|rate.?limit|quota|usage limit|capacity|credit|billing/i.test(
      text,
    )
  )
    return "وصل الحساب لحد الاستخدام أو الرصيد. راجع اشتراكك ثم أعد المحاولة.";
  if (
    /صلاحية الموديل|403|permission|not.*access|model.*(unavailable|not found)|404/i.test(
      text,
    )
  )
    return "الحساب لا يملك صلاحية الموديل أو الموديل غير متاح. راجع الموديل والاشتراك.";
  if (/غير مثبت|ENOENT|not found.*executable/i.test(text))
    return "برنامج المزوّد غير مثبت على السيرفر أو مساره غير صحيح.";
  if (/مهلة|timeout|timed out|abort/i.test(text))
    return "انتهت مهلة الاتصال بالمزوّد. تحقق من الشبكة وأعد المحاولة.";
  if (
    /شبكة السيرفر|network|fetch|connect|ENOTFOUND|ECONN|TLS|certificate/i.test(
      text,
    )
  )
    return "تعذر الوصول للمزوّد. راجع شبكة السيرفر وشهادة الاتصال ثم أعد المحاولة.";
  return "فشل طلب الموديل. راجع تسجيل الدخول وإتاحة الموديل ثم أعد اختبار الاتصال.";
}
