const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

async function loadQuickRepliesModule() {
  const source = await readFile(join(__dirname, '../src/quickReplies.js'), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('quick replies stay private per handler and chatop sees every set', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-replies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { createQuickRepliesStore } = await loadQuickRepliesModule();
  const store = createQuickRepliesStore(join(dir, 'quick-replies.json'));

  const firstCategory = await store.createCategory('handler-1', 'Приветствие');
  const secondCategory = await store.createCategory('handler-2', 'Оплата');
  const commonCategory = await store.createCategory(null, 'Общее');
  await store.createReply('handler-1', { categoryId: firstCategory.id, title: 'Приветствие', text: 'Здравствуйте!' });
  await store.createReply('handler-2', { categoryId: secondCategory.id, title: 'Проверка оплаты', text: 'Проверьте оплату.' });
  await store.createReply(null, { categoryId: commonCategory.id, title: 'Общий ответ', text: 'Ответ chatop.' });

  const first = await store.list('handler-1');
  const second = await store.list('handler-2');
  const all = await store.list(null);

  assert.deepEqual(first.categories.map((item) => item.name), ['Приветствие']);
  assert.deepEqual(first.replies.map((item) => item.text), ['Здравствуйте!']);
  assert.deepEqual(second.categories.map((item) => item.name), ['Оплата']);
  assert.deepEqual(second.replies.map((item) => item.text), ['Проверьте оплату.']);
  assert.equal(all.categories.length, 3);
  assert.equal(all.replies.length, 3);
});

test('category deletion preserves replies and drag order persists', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'quick-replies-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { createQuickRepliesStore } = await loadQuickRepliesModule();
  const store = createQuickRepliesStore(join(dir, 'quick-replies.json'));

  const category = await store.createCategory('handler-1', 'Ожидание');
  const otherCategory = await store.createCategory('handler-1', 'Оплата');
  await store.reorderCategories('handler-1', [otherCategory.id, category.id]);
  let categoryData = await store.list('handler-1');
  assert.deepEqual(categoryData.categories.map((item) => item.name), ['Оплата', 'Ожидание']);
  const first = await store.createReply('handler-1', { categoryId: category.id, title: 'Первый ответ', text: 'Первый' });
  const second = await store.createReply('handler-1', { categoryId: category.id, title: 'Второй ответ', text: 'Второй' });
  const loose = await store.createReply('handler-1', { categoryId: 'uncategorized', title: 'Свободный ответ', text: 'Без категории' });
  assert.equal(loose.categoryId, null);
  await store.reorderReplies('handler-1', [second.id, first.id]);

  let data = await store.list('handler-1');
  assert.deepEqual(data.replies.map((item) => item.text), ['Второй', 'Первый', 'Без категории']);

  await store.deleteCategory('handler-1', category.id);
  data = await store.list('handler-1');
  assert.deepEqual(data.categories.map((item) => item.name), ['Оплата']);
  assert.deepEqual(data.replies.map((item) => item.categoryId), [null, null, null]);
  await store.updateReply('handler-1', first.id, {
    categoryId: 'uncategorized',
    title: 'Исправленное название',
    text: 'Исправленный текст',
  });
  data = await store.list('handler-1');
  assert.equal(data.replies.find((item) => item.id === first.id).title, 'Исправленное название');
  assert.equal(data.replies.find((item) => item.id === first.id).text, 'Исправленный текст');
  await store.deleteReply('handler-1', loose.id);
  data = await store.list('handler-1');
  assert.equal(data.replies.some((item) => item.id === loose.id), false);
});
