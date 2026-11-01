'use strict';

(async () => {
  const api = window.electronAPI;
  const form = document.getElementById('unlockForm');
  const title = document.getElementById('title');
  const description = document.getElementById('description');
  const passphrase = document.getElementById('passphrase');
  const confirmation = document.getElementById('confirmPassphrase');
  const error = document.getElementById('error');
  const button = document.getElementById('submit');
  let creating = false;
  try {
    if (!api || typeof api.databaseStatus !== 'function') throw new Error('التطبيق غير مهيّأ لفتح التخزين المشفّر.');
    const status = await api.databaseStatus();
    if (!status?.ok) throw new Error(status?.message || 'تعذّر التحقق من قاعدة البيانات.');
    if (status.blocked) {
      title.textContent = 'ملف قاعدة البيانات مفقود';
      description.textContent = status.message || 'لم تُنشأ قاعدة بيانات جديدة. استعد ملف البيانات أولاً.';
      return;
    }
    creating = !status.exists;
    if (creating) {
      title.textContent = 'إنشاء قاعدة بيانات مشفّرة';
      description.textContent = status.canRemember
        ? 'اختر عبارة قوية من 12 حرفاً على الأقل. سيحفظها Windows محمية لفتح القاعدة تلقائياً لاحقاً.'
        : 'اختر عبارة قوية من 12 حرفاً على الأقل. الفتح التلقائي غير متاح حالياً، وقد تحتاج لإدخالها عند كل تشغيل.';
      document.getElementById('newDatabaseFields').classList.remove('hidden');
      button.textContent = 'إنشاء وفتح النظام';
    } else {
      description.textContent = status.message || (status.canRemember
        ? 'أدخل عبارة التشفير الأصلية مرة واحدة لتفعيل الفتح التلقائي على حساب Windows هذا.'
        : 'أدخل عبارة التشفير الأصلية لفتح قاعدة البيانات. الفتح التلقائي غير متاح حالياً.');
    }
    form.classList.remove('hidden');
    passphrase.focus();
  } catch (err) {
    description.textContent = 'تعذّر تهيئة التخزين المشفّر. لم تُحذف أي بيانات.';
    error.textContent = err.message;
    form.classList.remove('hidden');
    button.disabled = true;
    return;
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    const value = passphrase.value;
    if (creating && Array.from(value.trim()).length < 12) {
      error.textContent = 'اختر عبارة مرور من 12 حرفاً على الأقل.';
      return;
    }
    if (creating && value !== confirmation.value) {
      error.textContent = 'عبارتا التشفير غير متطابقتين.';
      return;
    }
    if (creating && !document.getElementById('savedPassphrase').checked) {
      error.textContent = 'يرجى تأكيد أنك حفظت عبارة التشفير في مكان آمن.';
      return;
    }
    button.disabled = true;
    try {
      const result = await api.unlockDatabase(value);
      if (!result?.ok) {
        error.textContent = result?.message || 'تعذّر فتح قاعدة البيانات. لم تُحذف البيانات.';
        return;
      }
      passphrase.value = '';
      confirmation.value = '';
      if (!result.automatic) alert(result.autoMessage || 'تعذّر تفعيل الفتح التلقائي؛ قد تُطلب عبارة التشفير عند التشغيل القادم.');
      api.enterClinic();
    } catch {
      error.textContent = 'تعذّر فتح قاعدة البيانات. لم تُحذف البيانات.';
    } finally {
      button.disabled = false;
    }
  });
})();
