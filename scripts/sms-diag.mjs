// Диагностика авто-СМС: показывает, на каком фильтре отваливаются клиенты.
// Запуск на сервере из корня проекта:
//   node scripts/sms-diag.mjs            # клиенты за последние 24ч
//   node scripts/sms-diag.mjs --hours=6  # за последние 6ч
//
// Ничего не отправляет и не пишет — только читает. Расчёт статуса воронки берётся
// из routes.js (та же функция, что в проде), поэтому картина совпадает с реальной.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prisma } from '../src/db.js';
import { computeFunnelMap, SMS_REMINDER_ELIGIBLE_STATUSES } from '../src/routes.js';

const hours = Number((process.argv.find((a) => a.startsWith('--hours=')) || '').split('=')[1]) || 24;
// Тот же критерий, что в проде: шлём только по первым 5 статусам воронки.
const willSend = (s) => SMS_REMINDER_ELIGIBLE_STATUSES.has(s);

const readJson = async (p, fb) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fb; } };

async function main() {
  const settings = await readJson(join(process.cwd(), 'data', 'app-settings.json'), {});
  const minutes = settings.smsReminderMinutes || 20;
  const window = minutes * 60 * 1000;
  const now = Date.now();
  const enabledAtMs = Date.parse(settings.smsReminderEnabledAt || '');
  const since = Number.isFinite(enabledAtMs) ? new Date(enabledAtMs) : new Date(now - hours * 3600 * 1000);
  const periodLabel = Number.isFinite(enabledAtMs) ? `С МОМЕНТА ВКЛЮЧЕНИЯ (${settings.smsReminderEnabledAt})` : `ЗА ${hours}ч`;

  console.log('═══ НАСТРОЙКИ ═══');
  console.log('  включено:', settings.smsReminderEnabled === true ? 'ДА' : 'НЕТ ← рассылка выключена!');
  console.log('  окно ожидания:', minutes, 'мин | отправитель:', settings.smsReminderSender);
  console.log('  включено с:', Number.isFinite(enabledAtMs) ? settings.smsReminderEnabledAt : 'не задано');

  const reminderState = await readJson(join(process.cwd(), 'data', 'sms-reminder-state.json'), {});

  // Кому уже слали (дедуп из лога и state-файла).
  const log = await readFile(join(process.cwd(), 'data', 'sms-log.jsonl'), 'utf8').catch(() => '');
  const already = new Set(
    log.trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e?.type === 'auto' && e.flowSessionId)
      .map((e) => e.flowSessionId),
  );
  for (const [sid, st] of Object.entries(reminderState || {})) {
    if (st?.sentAt) already.add(sid);
  }

  const clients = await prisma.webClient.findMany({
    where: { createdAt: { gte: since } },
    select: {
      flowSessionId: true, createdAt: true, updatedAt: true, submissionData: true,
      captchaPassed: true, operatorStatus: true,
      status: true, // панельный статус — то, что видно в админке (другая таксономия!)
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n═══ КЛИЕНТЫ ${periodLabel}: ${clients.length} ═══`);
  if (!clients.length) { console.log('  Клиентов нет — проверь период (--hours=48).'); return; }

  const funnel = await computeFunnelMap(clients);

  // Последнее сообщение в чате — прод смотрит на него же: webClient.updatedAt
  // от переписки не двигается, и живой диалог выглядел бы «застрявшим».
  const leads = await prisma.lead.findMany({
    where: { tgId: { in: clients.map((c) => 'chat:' + c.flowSessionId) } },
    select: { tgId: true, messages: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  const lastMsg = new Map();
  for (const l of leads) {
    const at = l.messages[0]?.createdAt;
    if (at) lastMsg.set(l.tgId.slice(5), new Date(at).getTime());
  }
  const statusIdleMin = (c) => Math.round((now - Number(reminderState[c.flowSessionId]?.statusSince || now)) / 60000);

  // Воронка фильтров — считаем, кто где отваливается.
  const tracked = clients.filter((c) => {
    const st = reminderState[c.flowSessionId];
    return st && st.status === funnel.get(c.flowSessionId);
  });
  const stalled = tracked.filter((c) => now - Number(reminderState[c.flowSessionId]?.statusSince || now) >= window);
  const byStatus = {};
  for (const c of stalled) byStatus[funnel.get(c.flowSessionId) ?? '(null — статус не определён)'] = (byStatus[funnel.get(c.flowSessionId) ?? '(null — статус не определён)'] || 0) + 1;

  const passStatus = stalled.filter((c) => willSend(funnel.get(c.flowSessionId)));
  const quiet = passStatus.filter((c) => now - (lastMsg.get(c.flowSessionId) || 0) >= window);
  const withPhone = quiet.filter((c) => reminderState[c.flowSessionId]?.phone);
  const fresh = withPhone.filter((c) => !already.has(c.flowSessionId));

  console.log('\n═══ ЦЕПОЧКА ФИЛЬТРОВ ═══');
  console.log(`  1. всего за период:                 ${clients.length}`);
  console.log(`  2. статус отслеживается state:       ${tracked.length}  (отсеяно: ${clients.length - tracked.length})`);
  console.log(`  3. статус стоит ≥ ${minutes} мин:          ${stalled.length}  (отсеяно: ${tracked.length - stalled.length})`);
  console.log(`  4. статус входит в первые 5:        ${passStatus.length}  (отсеяно: ${stalled.length - passStatus.length})`);
  console.log(`  5. в чате тихо ≥ ${minutes} мин:           ${quiet.length}  (отсеяно: ${passStatus.length - quiet.length} — диалог живой)`);
  console.log(`  6. есть телефон:                    ${withPhone.length}  (отсеяно: ${quiet.length - withPhone.length})`);
  console.log(`  7. ещё не слали:                    ${fresh.length}  (отсеяно: ${withPhone.length - fresh.length})`);
  console.log(`\n  ⇒ ушло бы СМС (по текущим фильтрам диагноза): ${fresh.length}`);

  console.log('\n═══ НА КАКИХ СТАТУСАХ ЗАСТРЯЛИ ═══');
  console.log('  (шлём только по первым 5 статусам: ' + [...SMS_REMINDER_ELIGIBLE_STATUSES].join(' / ') + ')');
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    const ok = willSend(s === '(null — статус не определён)' ? null : s) ? '✓ шлём' : '✗ НЕ шлём';
    console.log(`  ${String(n).padStart(4)}  ${ok.padEnd(9)}  ${s}`);
  }

  // Панельный статус (webClient.status) — это НЕ статус воронки. В админке видно
  // именно его, а фильтр СМС работает по воронке — сверяем их напрямую.
  console.log('\n═══ ПАНЕЛЬНЫЙ СТАТУС → СТАТУС ВОРОНКИ (застрявшие) ═══');
  const pairs = {};
  for (const c of stalled) {
    const k = (c.status || '(пусто)') + '  →  ' + (funnel.get(c.flowSessionId) ?? '(null)');
    pairs[k] = (pairs[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(pairs).sort((a, b) => b[1] - a[1])) {
    const fs = k.split('  →  ')[1];
    console.log(`  ${String(n).padStart(4)}  ${willSend(fs === '(null)' ? null : fs) ? '✓ шлём   ' : '✗ НЕ шлём'}  ${k}`);
  }

  console.log('\n═══ ПОСЛЕДНИЕ 15 КЛИЕНТОВ ═══');
  console.log('  (статус = минуты на текущем статусе по state; в скобках — «сырой» updatedAt)');
  for (const c of clients.slice(0, 15)) {
    const raw = Math.round((now - new Date(c.updatedAt).getTime()) / 60000);
    const s = funnel.get(c.flowSessionId) ?? '(null)';
    console.log(
      `  ${c.flowSessionId.padEnd(12)} создан ${c.createdAt.toISOString().slice(5, 16)}` +
      ` | статус ${String(statusIdleMin(c)).padStart(4)}м (${String(raw).padStart(4)}м)` +
      ` | тел: ${reminderState[c.flowSessionId]?.phone ? 'да ' : 'НЕТ'}` +
      ` | ${already.has(c.flowSessionId) ? 'слали ' : 'не слали'}` +
      ` | панель: ${String(c.status || '—').padEnd(22)} | воронка: ${s}`,
    );
  }
}

main()
  .catch((e) => { console.error('ОШИБКА:', e?.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
