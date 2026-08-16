import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const DEFAULT_FILE = join(process.cwd(), 'data', 'quick-replies.json');

export class QuickRepliesError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'QuickRepliesError';
    this.code = code;
    this.status = status;
  }
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeOwner(value) {
  return typeof value === 'string' && value ? value : null;
}

function normalizeCategoryId(value) {
  const id = cleanText(value, 100);
  return id && id !== 'uncategorized' ? id : null;
}

function normalizeOrder(value, fallback) {
  const order = Number(value);
  return Number.isFinite(order) ? order : fallback;
}

function normalizeStore(value) {
  const rawCategories = Array.isArray(value?.categories) ? value.categories : [];
  const rawReplies = Array.isArray(value?.replies) ? value.replies : [];
  const categories = rawCategories
    .filter((item) => item && typeof item.id === 'string' && cleanText(item.name, 80))
    .map((item, index) => ({
      id: item.id,
      ownerHandlerId: normalizeOwner(item.ownerHandlerId),
      name: cleanText(item.name, 80),
      sortOrder: normalizeOrder(item.sortOrder, (index + 1) * 10),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    }));
  const categoryIds = new Set(categories.map((item) => item.id));
  const replies = rawReplies
    .filter((item) => item && typeof item.id === 'string' && cleanText(item.text, 4000))
    .map((item, index) => ({
      id: item.id,
      ownerHandlerId: normalizeOwner(item.ownerHandlerId),
      categoryId: categoryIds.has(item.categoryId) ? item.categoryId : null,
      // Старые записи создавались без отдельного названия. Для них используем
      // начало текста, поэтому обновление не требует ручной миграции файла.
      title: cleanText(item.title, 120) || cleanText(item.text, 120),
      text: cleanText(item.text, 4000),
      sortOrder: normalizeOrder(item.sortOrder, (index + 1) * 10),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    }));
  return { version: 1, categories, replies };
}

function ordered(items) {
  return [...items].sort((a, b) => (
    a.sortOrder - b.sortOrder ||
    String(a.createdAt).localeCompare(String(b.createdAt)) ||
    a.id.localeCompare(b.id)
  ));
}

function isVisible(item, actorHandlerId) {
  return actorHandlerId === null || item.ownerHandlerId === actorHandlerId;
}

function canManage(item, actorHandlerId) {
  return actorHandlerId === null || item.ownerHandlerId === actorHandlerId;
}

export function createQuickRepliesStore(filePath = DEFAULT_FILE) {
  let mutationQueue = Promise.resolve();

  async function readStore() {
    try {
      return normalizeStore(JSON.parse(await readFile(filePath, 'utf8')));
    } catch {
      return normalizeStore(null);
    }
  }

  async function writeStore(store) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(normalizeStore(store), null, 2), 'utf8');
  }

  function mutate(mutator) {
    const job = mutationQueue.then(async () => {
      const store = await readStore();
      const result = await mutator(store);
      await writeStore(store);
      return result;
    });
    mutationQueue = job.catch(() => undefined);
    return job;
  }

  async function list(actorHandlerId) {
    await mutationQueue.catch(() => undefined);
    const store = await readStore();
    return {
      categories: ordered(store.categories.filter((item) => isVisible(item, actorHandlerId))),
      replies: ordered(store.replies.filter((item) => isVisible(item, actorHandlerId))),
    };
  }

  async function createCategory(actorHandlerId, nameValue) {
    const name = cleanText(nameValue, 80);
    if (!name) throw new QuickRepliesError('category_name_required');
    return mutate(async (store) => {
      const duplicate = store.categories.some((item) => (
        item.ownerHandlerId === actorHandlerId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase()
      ));
      if (duplicate) throw new QuickRepliesError('category_exists', 409);
      const ownerCategories = store.categories.filter((item) => item.ownerHandlerId === actorHandlerId);
      const category = {
        id: randomUUID(),
        ownerHandlerId: actorHandlerId,
        name,
        sortOrder: Math.max(0, ...ownerCategories.map((item) => item.sortOrder)) + 10,
        createdAt: new Date().toISOString(),
      };
      store.categories.push(category);
      return category;
    });
  }

  async function deleteCategory(actorHandlerId, categoryIdValue) {
    const categoryId = cleanText(categoryIdValue, 100);
    if (!categoryId) throw new QuickRepliesError('category_id_required');
    return mutate(async (store) => {
      const category = store.categories.find((item) => item.id === categoryId);
      if (!category) throw new QuickRepliesError('category_not_found', 404);
      if (!canManage(category, actorHandlerId)) throw new QuickRepliesError('forbidden', 403);
      store.categories = store.categories.filter((item) => item.id !== categoryId);
      for (const reply of store.replies) {
        if (reply.categoryId === categoryId) reply.categoryId = null;
      }
      return { id: categoryId };
    });
  }

  async function reorderCategories(actorHandlerId, categoryIdsValue) {
    const categoryIds = Array.isArray(categoryIdsValue)
      ? [...new Set(categoryIdsValue.map((id) => cleanText(id, 100)).filter(Boolean))]
      : [];
    if (!categoryIds.length) throw new QuickRepliesError('category_ids_required');
    return mutate(async (store) => {
      const byId = new Map(store.categories.map((item) => [item.id, item]));
      for (const id of categoryIds) {
        const category = byId.get(id);
        if (!category) throw new QuickRepliesError('category_not_found', 404);
        if (!canManage(category, actorHandlerId)) throw new QuickRepliesError('forbidden', 403);
      }
      categoryIds.forEach((id, index) => { byId.get(id).sortOrder = (index + 1) * 10; });
      return { categoryIds };
    });
  }

  async function createReply(actorHandlerId, input) {
    const title = cleanText(input?.title, 120);
    const text = cleanText(input?.text, 4000);
    const categoryId = normalizeCategoryId(input?.categoryId);
    if (!title) throw new QuickRepliesError('reply_title_required');
    if (!text) throw new QuickRepliesError('reply_text_required');
    return mutate(async (store) => {
      const category = categoryId ? store.categories.find((item) => item.id === categoryId) : null;
      if (categoryId && !category) throw new QuickRepliesError('category_not_found', 404);
      if (category && !canManage(category, actorHandlerId)) throw new QuickRepliesError('forbidden', 403);
      const reply = {
        id: randomUUID(),
        ownerHandlerId: category ? category.ownerHandlerId : actorHandlerId,
        categoryId,
        title,
        text,
        // Порядок общий для файла: тогда перестановка внутри выбранной категории
        // не ломает положение остальных категорий во вкладке «Все».
        sortOrder: Math.max(0, ...store.replies.map((item) => item.sortOrder)) + 10,
        createdAt: new Date().toISOString(),
      };
      store.replies.push(reply);
      return reply;
    });
  }

  async function updateReply(actorHandlerId, replyIdValue, input) {
    const replyId = cleanText(replyIdValue, 100);
    const title = cleanText(input?.title, 120);
    const text = cleanText(input?.text, 4000);
    const categoryId = normalizeCategoryId(input?.categoryId);
    if (!replyId) throw new QuickRepliesError('reply_id_required');
    if (!title) throw new QuickRepliesError('reply_title_required');
    if (!text) throw new QuickRepliesError('reply_text_required');
    return mutate(async (store) => {
      const reply = store.replies.find((item) => item.id === replyId);
      if (!reply) throw new QuickRepliesError('reply_not_found', 404);
      if (!canManage(reply, actorHandlerId)) throw new QuickRepliesError('forbidden', 403);
      const category = categoryId ? store.categories.find((item) => item.id === categoryId) : null;
      if (categoryId && !category) throw new QuickRepliesError('category_not_found', 404);
      if (category && !canManage(category, actorHandlerId)) throw new QuickRepliesError('forbidden', 403);
      reply.title = title;
      reply.text = text;
      reply.categoryId = categoryId;
      // При переносе в реальную категорию набор становится набором её владельца.
      // «Без категории» владельца не меняет, что особенно важно для общего chatop.
      if (category) reply.ownerHandlerId = category.ownerHandlerId;
      return reply;
    });
  }

  async function deleteReply(actorHandlerId, replyIdValue) {
    const replyId = cleanText(replyIdValue, 100);
    if (!replyId) throw new QuickRepliesError('reply_id_required');
    return mutate(async (store) => {
      const reply = store.replies.find((item) => item.id === replyId);
      if (!reply) throw new QuickRepliesError('reply_not_found', 404);
      if (!canManage(reply, actorHandlerId)) throw new QuickRepliesError('forbidden', 403);
      store.replies = store.replies.filter((item) => item.id !== replyId);
      return { id: replyId };
    });
  }

  async function reorderReplies(actorHandlerId, replyIdsValue) {
    const replyIds = Array.isArray(replyIdsValue)
      ? [...new Set(replyIdsValue.map((id) => cleanText(id, 100)).filter(Boolean))]
      : [];
    if (!replyIds.length) throw new QuickRepliesError('reply_ids_required');
    return mutate(async (store) => {
      const byId = new Map(store.replies.map((item) => [item.id, item]));
      for (const id of replyIds) {
        const reply = byId.get(id);
        if (!reply) throw new QuickRepliesError('reply_not_found', 404);
        if (!canManage(reply, actorHandlerId)) throw new QuickRepliesError('forbidden', 403);
      }
      // Меняем местами существующие позиции выбранных строк. Скрытые текущим
      // фильтром ответы остаются ровно на своих местах в общем списке.
      const orderSlots = replyIds.map((id) => byId.get(id).sortOrder).sort((a, b) => a - b);
      replyIds.forEach((id, index) => { byId.get(id).sortOrder = orderSlots[index]; });
      return { replyIds };
    });
  }

  return { list, createCategory, deleteCategory, reorderCategories, createReply, updateReply, deleteReply, reorderReplies };
}

export const quickRepliesStore = createQuickRepliesStore();
