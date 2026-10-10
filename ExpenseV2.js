// Finance Platform Bot v1 — Cloudflare Worker (Telegram + Notion)
//
// Bindings / secrets:
//   TELEGRAM_TOKEN, NOTION_TOKEN, WEBHOOK_SECRET
//   ALLOWED_USER_ID            (الزامی؛ آیدی عددی تلگرام، چند آیدی با کاما)
//   NOTION_TRANSACTIONS_DB_ID, NOTION_ACCOUNTS_DB_ID, NOTION_CATEGORIES_DB_ID,
//   NOTION_BOXES_DB_ID, NOTION_ALLOCATIONS_DB_ID, NOTION_ASSETS_DB_ID, NOTION_GOALS_DB_ID
//   DB                         (D1 binding برای ذخیره‌ی وضعیت مکالمه‌ها)
//   BOT_API_BASE               (اختیاری)
//   BROWSER                    (اختیاری؛ Browser Rendering binding برای PDF)
//   CLOUDFLARE_ACCOUNT_ID      (اختیاری؛ برای خروجی PDF)
//   CLOUDFLARE_API_TOKEN       (اختیاری؛ دسترسی Browser Rendering Write)
//
// قواعد پول:  ورودی و نمایش = تومان  |  ذخیره در Notion = ریال (۱ تومان = ۱۰ ریال)

const NOTION_VERSION = "2022-06-28";
const DEFAULT_CURRENCY = "IRR";
const STATE_TTL_MS = 30 * 60 * 1000;
const RIAL_PER_TOMAN = 10;
const PAGE_SIZE = 10;
const PICK_SIZE = 20;
const MAX_EXPORT_ROWS = 5000;
const UI_MESSAGE_LIMIT = 60;
const MARKET_PRICE_CACHE_MS = 60 * 1000;
const GOLD_MISKAL_TO_18K_GRAM = 4.3318;
let marketPriceCache = { expiresAt: 0, text: null };

const DB = {
  transactions: "NOTION_TRANSACTIONS_DB_ID",
  accounts: "NOTION_ACCOUNTS_DB_ID",
  categories: "NOTION_CATEGORIES_DB_ID",
  boxes: "NOTION_BOXES_DB_ID",
  allocations: "NOTION_ALLOCATIONS_DB_ID",
  assets: "NOTION_ASSETS_DB_ID",
  goals: "NOTION_GOALS_DB_ID",
};

const TX = {
  title: "تراکنش",
  type: "نوع",
  amount: "مبلغ",
  currency: "ارز",
  date: "تاریخ",
  fromAccount: "از حساب",
  toAccount: "به حساب",
  category: "دسته‌بندی",
  box: "باکس",
  asset: "دارایی",
  assetQty: "مقدار دارایی",
  unitPrice: "قیمت واحد",
  goal: "هدف مالی",
  status: "وضعیت",
  desc: "توضیحات",
  chartGroup: "نمای نمودار",
};
const ACC = {
  title: "حساب",
  balance: "موجودی",
  currency: "ارز",
  type: "نوع حساب",
  active: "فعال",
};
const CAT = {
  title: "دسته‌بندی",
  level: "سطح",
  active: "فعال",
  parent: "دسته مادر",
};
const BOX = {
  title: "باکس",
  code: "کد",
  order: "ترتیب",
  balance: "مانده",
  active: "فعال",
  system: "سیستمی",
  incoming: "ورودی",
  outgoing: "خروجی",
};
const AST = {
  title: "دارایی",
  type: "نوع دارایی",
  symbol: "نماد",
  unit: "واحد",
  currency: "ارز پایه",
  qty: "مقدار فعلی",
  price: "قیمت فعلی",
  value: "ارزش بازار",
  active: "فعال",
};
const GOL = {
  title: "هدف",
  type: "نوع هدف",
  target: "مبلغ هدف",
  allocated: "تخصیص‌شده",
  progress: "پیشرفت",
  status: "وضعیت",
  date: "تاریخ هدف",
  priority: "اولویت",
};
const ALC = {
  title: "تخصیص",
  amount: "مبلغ",
  date: "تاریخ",
  fromBox: "از باکس",
  toBox: "به باکس",
  fromAccount: "از حساب",
  toAccount: "به حساب",
  goal: "هدف مالی",
  status: "وضعیت",
  desc: "توضیحات",
};

const TX_TYPES = ["هزینه", "درآمد", "انتقال", "خرید دارایی", "فروش دارایی"];
const TYPE_META = {
  هزینه: {
    icon: "💸",
    chart: "خرج",
    accountMode: "from",
    optionalBox: true,
    optionalCategory: true,
  },
  درآمد: {
    icon: "💰",
    chart: null,
    accountMode: "to",
    needsBox: false,
    optionalBox: true,
    optionalCategory: true,
  },
  انتقال: {
    icon: "🔁",
    chart: null,
    accountMode: "both",
    needsBox: false,
    needsCategory: false,
  },
  "خرید دارایی": {
    icon: "📈",
    chart: "دارایی",
    accountMode: "from",
    optionalBox: true,
    needsCategory: false,
    needsAsset: true,
  },
  "فروش دارایی": {
    icon: "📉",
    chart: "دارایی",
    accountMode: "to",
    optionalBox: true,
    needsBox: false,
    needsCategory: false,
    needsAsset: true,
  },
};

// تعریف جدول‌ها. money = ستون‌هایی که مبلغ (ریال) هستند و باید به تومان نمایش داده شوند.
const ENT = {
  t: {
    key: "transactions",
    fa: "تراکنش‌ها",
    one: "تراکنش",
    icon: "💳",
    title: TX.title,
    date: TX.date,
    money: [TX.amount, TX.unitPrice],
    groups: {
      day: { label: "📅 روزانه" },
      month: { label: "🗓 ماهانه" },
      category: { label: "🏷 دسته‌بندی", rel: TX.category },
      box: { label: "📦 باکس", rel: TX.box },
    },
  },
  l: {
    key: "allocations",
    fa: "تخصیص‌ها",
    one: "تخصیص",
    icon: "🎯",
    title: ALC.title,
    date: ALC.date,
    money: [ALC.amount],
    groups: {
      day: { label: "📅 روزانه" },
      month: { label: "🗓 ماهانه" },
      fromBox: { label: "📦 از باکس", rel: ALC.fromBox },
      toBox: { label: "📦 به باکس", rel: ALC.toBox },
      fromAccount: { label: "🏦 از حساب", rel: ALC.fromAccount },
      toAccount: { label: "🏦 به حساب", rel: ALC.toAccount },
    },
  },
  a: {
    key: "accounts",
    fa: "حساب‌ها",
    one: "حساب",
    icon: "🏦",
    title: ACC.title,
    money: [ACC.balance],
  },
  b: {
    key: "boxes",
    fa: "باکس‌ها",
    one: "باکس",
    icon: "📦",
    title: BOX.title,
    money: [BOX.balance],
  },
  c: {
    key: "categories",
    fa: "دسته‌بندی‌ها",
    one: "دسته‌بندی",
    icon: "🏷",
    title: CAT.title,
    money: [],
  },
  s: {
    key: "assets",
    fa: "دارایی‌ها",
    one: "دارایی",
    icon: "💎",
    title: AST.title,
    money: [AST.price, AST.value],
  },
  g: {
    key: "goals",
    fa: "اهداف",
    one: "هدف",
    icon: "🏁",
    title: GOL.title,
    money: [GOL.target, GOL.allocated],
  },
};
const ENT_ORDER = ["t", "l", "a", "b", "c", "s"];
const EDITABLE = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "status",
  "multi_select",
  "date",
  "checkbox",
  "relation",
  "url",
  "email",
  "phone_number",
]);

/* ============================== Entry ============================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/setup") return setup(url, env);
    if (url.pathname === "/health")
      return new Response("finance platform v1 is running");

    if (request.method === "POST" && url.pathname.startsWith("/webhook")) {
      const headerOk =
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") ===
        env.WEBHOOK_SECRET;
      const pathOk = url.pathname === `/webhook/${env.WEBHOOK_SECRET}`;
      if (!env.WEBHOOK_SECRET || !(headerOk || pathOk)) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      // فوراً پاسخ می‌دهیم تا تلگرام آپدیت را دوباره نفرستد؛ کار اصلی در پس‌زمینه انجام می‌شود.
      ctx.waitUntil(processUpdate(update, env));
      return new Response("ok");
    }
    return new Response("finance bot v3");
  },
};

async function processUpdate(update, env) {
  try {
    await handleUpdate(update, env);
  } catch (err) {
    console.error(err);
    const chatId =
      update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId)
      await send(env, chatId, `⚠️ خطا: ${esc(err.message)}`).catch(() => {});
  }
}

async function setup(url, env) {
  assertEnv(env);
  if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const webhook = await tg(env, "setWebhook", {
    url: `${url.origin}/webhook/${env.WEBHOOK_SECRET}`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  const commands = await tg(env, "setMyCommands", {
    commands: [
      { command: "start", description: "منوی اصلی مالی" },
      { command: "menu", description: "نمایش منو" },
      { command: "csv", description: "گزارش CSV یا PDF" },
      { command: "check", description: "بررسی اتصال به Notion" },
      { command: "cancel", description: "لغو عملیات جاری" },
    ],
  });
  return Response.json({ webhook, commands });
}

async function handleUpdate(update, env) {
  assertEnv(env);
  const from = update.message?.from ?? update.callback_query?.from;
  const allowed = String(env.ALLOWED_USER_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!from || !allowed.includes(String(from.id))) {
    if (update.callback_query) {
      await tg(env, "answerCallbackQuery", {
        callback_query_id: update.callback_query.id,
      });
    } else if (update.message) {
      const hint = allowed.length
        ? ""
        : "\nمقدار ALLOWED_USER_ID را با همین آیدی تنظیم کن.";
      await send(
        env,
        update.message.chat.id,
        `⛔️ دسترسی ندارید.\nID: ${from?.id}${hint}`,
      );
    }
    return;
  }

  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message?.text) return handleText(update.message, env);
}

/* ============================== Text ============================== */

async function handleText(msg, env) {
  try {
    const isCommand = msg.text.trim().startsWith("/");
    const previousState = isCommand ? null : await getState(env, msg.chat.id);
    const result = await handleTextMessage(msg, env);
    if (previousState) {
      const currentState = await getState(env, msg.chat.id);
      if (JSON.stringify(previousState) === JSON.stringify(currentState))
        await repeatExpectedInput(env, msg.chat.id, previousState);
    }
    return result;
  } finally {
    await tg(env, "deleteMessage", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
    }).catch(() => {});
  }
}

async function handleTextMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0] : null;
  await rememberMessage(env, chatId, msg).catch(() => {});

  if (cmd === "/start" || cmd === "/menu") {
    await clearState(env, chatId);
    await cleanupMessages(env, chatId);
    return sendMainMenu(env, chatId);
  }
  if (cmd === "/cancel") {
    await clearState(env, chatId);
    await cleanupMessages(env, chatId);
    return sendMainMenu(env, chatId, "❌ عملیات لغو شد.");
  }
  if (cmd === "/check") {
    await clearActiveMenus(env, chatId, null, { deleteMenus: true }).catch(
      () => {},
    );
    return send(env, chatId, await checkConnections(env));
  }
  if (cmd === "/csv") {
    await clearState(env, chatId);
    await clearActiveMenus(env, chatId, null, { deleteMenus: true }).catch(
      () => {},
    );
    return reportTableMenu(env, chatId, null);
  }

  const state = await getState(env, chatId);
  if (state && acceptsTextInput(state)) {
    await cleanupMessages(env, chatId, msg.message_id).catch(() => {});
  } else if (!state) {
    await clearActiveMenus(env, chatId, null, { deleteMenus: !state }).catch(
      () => {},
    );
  }
  if (!state) return sendMainMenu(env, chatId, "از منوی زیر انتخاب کن 👇");

  if (state.flow === "new" && state.assetFlow)
    return handleAssetCreateText(env, chatId, state, text);
  if (state.flow === "asset-sale")
    return handleAssetSaleText(env, chatId, state, text);

  // ---- ثبت تراکنش ----
  if (state.flow === "tx" && state.step === "title") {
    if (!text || text.length > 200) {
      return send(env, chatId, "❌ عنوان تراکنش را بین ۱ تا ۲۰۰ نویسه وارد کن؛ مثلاً «خرید هفتگی» یا «حقوق مهرماه».");
    }
    state.draft.title = text;
    state.draft.date = todayTehran();
    state.step = "amount-choice";
    await setState(env, chatId, state);
    return askTxAmount(env, chatId, state);
  }

  if (state.flow === "tx" && state.step === "description-input") {
    state.draft.desc = text.slice(0, 2000);
    state.descriptionDone = true;
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state);
  }

  if (state.flow === "tx" && state.step === "amount-input") {
    const amount = parseScaledAmount(text, state.moneyUnitFactor);
    if (!(amount > 0))
      return send(env, chatId, scaledAmountError(state.moneyUnitFactor));
    state.pendingAmount = amount;
    state.step = "amount-review";
    await setState(env, chatId, state);
    return sendAmountReview(
      env,
      chatId,
      amount,
      "tx:amount-ok",
      "tx:amount-edit",
    );
  }

  // سازگاری با ورودی‌هایی که پیش از انتشار این مسیر شروع شده‌اند.
  if (state.flow === "tx" && state.step === "amount") {
    const amount = parseAmountOnly(text);
    if (!(amount > 0)) return send(env, chatId, "❌ مبلغ نامعتبر است.");
    state.draft.amount = amount;
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state);
  }

  if (state.flow === "tx" && state.step === "assetQty") {
    const qty = parseFloat(toEnDigits(text).replace(",", "."));
    if (!(qty > 0))
      return send(env, chatId, "❌ مقدار دارایی نامعتبر است. مثال: 0.5");
    state.draft.assetQty = qty;
    state.draft.unitPrice = Math.round(state.draft.amount / qty);
    state.step = "confirm";
    await setState(env, chatId, state);
    return sendTxConfirm(env, chatId, state);
  }

  // ---- تخصیص ----
  if (state.flow === "allocation" && state.step === "amount-input") {
    const amount = parseScaledAmount(text, state.moneyUnitFactor);
    if (!(amount > 0))
      return send(env, chatId, scaledAmountError(state.moneyUnitFactor));
    if (amount > state.maxAmount)
      return send(
        env,
        chatId,
        `❌ مبلغ از موجودی قابل تخصیص بیشتر است. موجودی: <b>${fmt(state.maxAmount)} تومان</b>`,
      );
    state.pendingAmount = amount;
    state.step = "amount-review";
    await setState(env, chatId, state);
    return sendAmountReview(
      env,
      chatId,
      amount,
      "al:amount-ok",
      "al:amount-edit",
    );
  }
  if (state.flow === "allocation" && state.step === "percent-input") {
    const percent = parsePercentInput(text);
    if (!(percent > 0 && percent <= 100))
      return send(
        env,
        chatId,
        "❌ درصد را از ۱ تا ۱۰۰ وارد کن؛ مثلاً <code>۲۵</code>.",
      );
    const amount = Math.round((state.maxAmount * percent) / 100);
    if (!(amount > 0))
      return send(
        env,
        chatId,
        "❌ این درصد از موجودی مبلغ قابل تخصیصی ایجاد نمی‌کند.",
      );
    state.pendingAmount = amount;
    state.selectedPercent = percent;
    state.step = "amount-review";
    await setState(env, chatId, state);
    return sendAmountReview(
      env,
      chatId,
      amount,
      "al:amount-ok",
      "al:amount-edit",
    );
  }
  if (state.flow === "allocation" && state.step === "amount") {
    const amount = parseAmountOnly(text);
    if (!(amount > 0)) return send(env, chatId, "❌ مبلغ نامعتبر است.");
    state.draft.amount = amount;
    state.step = "confirm";
    await setState(env, chatId, state);
    return sendAllocationConfirm(env, chatId, state);
  }

  // ---- ویرایش / ایجاد (CRUD) ----
  if (
    (state.flow === "edit" || state.flow === "new") &&
    ["text", "money-input"].includes(state.step)
  ) {
    return handleFieldText(env, chatId, state, text);
  }
  if ((state.flow === "edit" || state.flow === "new") && state.step === "rel") {
    return handleRelationSearch(env, chatId, state, text);
  }

  // ---- گزارش ----
  if (state.flow === "report" && state.step === "range") {
    const range = parseRangeInput(text);
    if (!range) {
      return send(
        env,
        chatId,
        "❌ بازه نامعتبر است. نمونه‌ها:\n<code>1405/07/12</code>\n<code>1405/07</code>\n<code>1405/07/01 تا 1405/07/15</code>",
      );
    }
    state.range = range;
    state.step = null;
    await setState(env, chatId, state);
    return afterRange(env, chatId, null, state);
  }

  return send(
    env,
    chatId,
    "❌ این مرحله ورودی متنی نمی‌گیرد. لطفاً گزینه‌ی مناسب را از منوی زیر انتخاب کن؛ پیام اشتباهت پاک شد.",
  );
}

async function repeatExpectedInput(env, chatId, state) {
  const prompt = (text, placeholder = "") =>
    send(env, chatId, text, {
      reply_markup: { force_reply: true, input_field_placeholder: placeholder },
    });

  if (state.flow === "tx") {
    if (state.step === "title")
      return prompt("عنوان تراکنش را وارد کن؛ مثلاً «خرید هفتگی» یا «حقوق مهرماه».", "مثلاً خرید هفتگی");
    if (state.step === "amount-input")
      return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
    if (state.step === "assetQty")
      return prompt("مقدار دارایی را به‌صورت عدد وارد کن؛ مثلاً <code>۰٫۵</code>.", "مثلاً ۰٫۵");
    if (state.step === "description-input")
      return panel(env, chatId, null, "توضیح را بنویس یا برای رد کردن از دکمه استفاده کن.", {
        inline_keyboard: [[btn("⏭ رد کردن توضیحات", "tx:desc-skip")], [btn("❌ لغو", "tx:cancel")]],
      });
    if (["amount-choice", "amount-unit"].includes(state.step))
      return showMoneyUnitChoice(env, chatId, null, "tx", "tx:cancel");
  }
  if (state.flow === "allocation") {
    if (state.step === "amount-input")
      return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
    if (["amount-unit", "amount-choice"].includes(state.step))
      return showMoneyUnitChoice(env, chatId, null, "al", "al:cancel");
    if (state.step === "percent-input")
      return prompt("درصد را از ۱ تا ۱۰۰ وارد کن؛ مثلاً <code>۲۵</code>.", "مثلاً ۲۵");
    if (state.step === "amount")
      return prompt("مبلغ را به تومان وارد کن؛ فقط عدد بفرست.", "مثلاً ۵۰۰۰۰۰");
  }
  if (state.flow === "asset-sale") {
    if (state.step === "quantity")
      return prompt(`مقدار فروخته‌شده را تا حداکثر ${fa(state.asset.qty)} وارد کن.`, "مثلاً ۱");
    if (["base-price", "proceeds"].includes(state.step))
      return prompt(state.step === "base-price" ? "قیمت پایه‌ی هر واحد را به تومان وارد کن:" : "مبلغ کل فروخته‌شده را به تومان وارد کن:", "مبلغ به تومان");
    if (state.step === "destination")
      return send(env, chatId, "لطفاً مقصد واریز را از گزینه‌های نمایش‌داده‌شده انتخاب کن.");
  }
  if (state.flow === "new" && state.assetFlow) {
    if (state.assetStep === "title")
      return prompt("عنوان دارایی را وارد کن؛ مثلاً «دلار» یا «طلای ۱۸ عیار».", "مثلاً دلار");
    if (state.assetStep === "description")
      return panel(env, chatId, null, "توضیحات دارایی را وارد کن یا برای رد کردن، «-» بفرست.", {
        inline_keyboard: [[btn("⏭ رد کردن توضیحات", "x:assetdescskip")], [btn("❌ لغو", "x:x")]],
      });
    if (["price-input", "cost-input"].includes(state.assetStep))
      return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
    if (state.assetStep === "quantity")
      return prompt("مقدار دارایی را به‌صورت عدد وارد کن؛ مثلاً <code>۰٫۵</code>.", "مثلاً ۰٫۵");
    if (["cost-unit", "price-unit"].includes(state.assetStep))
      return showMoneyUnitChoice(env, chatId, null, "x", "x:x");
    return send(env, chatId, "لطفاً گزینه‌ی مناسب را از منوی نمایش‌داده‌شده انتخاب کن.");
  }
  if (state.flow === "edit" || state.flow === "new") {
    if (state.step === "money-input")
      return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
    if (state.step === "text")
      return prompt("مقدار این فیلد را وارد کن یا برای خالی گذاشتن «-» بفرست.");
    if (state.step === "rel")
      return send(env, chatId, "برای جست‌وجوی مورد مرتبط، نامش را وارد کن.");
  }
  if (state.flow === "report" && state.step === "range")
    return prompt("بازه‌ی گزارش را وارد کن؛ مثلاً <code>۱۴۰۵/۰۷</code> یا <code>۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۱۵</code>.");
  return send(env, chatId, "لطفاً گزینه‌ی مناسب را از منوی فعال انتخاب کن.");
}

function acceptsTextInput(state) {
  if (state.flow === "tx")
    return ["title", "amount-input", "amount", "assetQty", "description-input"].includes(
      state.step,
    );
  if (state.flow === "asset-sale")
    return ["quantity", "base-price", "proceeds"].includes(state.step);
  if (state.flow === "new" && state.assetFlow)
    return ["title", "description", "price-input", "quantity", "cost-input"].includes(
      state.assetStep,
    );
  if (state.flow === "allocation")
    return ["amount-input", "percent-input", "amount"].includes(state.step);
  if (state.flow === "edit" || state.flow === "new")
    return ["text", "money-input", "rel"].includes(state.step);
  return state.flow === "report" && state.step === "range";
}

/* ============================== Callbacks ============================== */

async function handleCallback(cq, env) {
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  const msg = cq.message;
  if (!msg) return;
  if (!(await claimCallbackAction(env, cq))) return;
  const [ns, action, ...args] = String(cq.data || "").split(":");

  if (ns === "m" && action === "noop") return;
  const activeMenuState = await getActiveMenuState(env, msg.chat.id);
  const activeMenus = activeMenuState.ids;
  if (
    activeMenuState.initialized &&
    !activeMenus.includes(Number(msg.message_id))
  )
    return;
  await clearActiveMenus(env, msg.chat.id, activeMenuState, {
    deleteMenus: true,
    keepId: msg.message_id,
  }).catch(() => {});
  if (ns === "m") return handleMenu(env, msg, action);
  if (ns === "tx") return handleTxCallback(env, msg, action, args);
  if (ns === "as") return handleAssetSaleCallback(env, msg, action, args);
  if (ns === "al") return handleAllocationCallback(env, msg, action, args);
  if (ns === "x") return handleCrud(env, msg, action, args);
  if (ns === "r") return handleReportCallback(env, msg, action, args);
}

async function handleMenu(env, msg, action) {
  const chatId = msg.chat.id;
  await clearState(env, chatId);

  const listMap = {
    txhistory: "t",
    accounts: "a",
    boxes: "b",
    assets: "s",
    allocationhistory: "l",
    categories: "c",
  };
  if (listMap[action]) return listEntity(env, chatId, msg, listMap[action], 0);
  if (action === "assetpricesrefresh")
    marketPriceCache = { expiresAt: 0, text: null };
  if (action === "assetprices" || action === "assetpricesrefresh")
    return showMarketPrices(env, msg);

  if (action === "transactions")
    return editPanel(
      env,
      msg,
      "💳 <b>تراکنش‌ها</b>\nدرآمد و هزینه‌هایت را ثبت کن یا سوابق تراکنش‌ها را ببین.\nاز کدام گزینه شروع کنیم؟",
      transactionsKeyboard(),
    );
  if (action === "allocations")
    return editPanel(
      env,
      msg,
      "🎯 <b>تخصیص منابع</b>\nیکی از گزینه‌ها را انتخاب کن:",
      {
        inline_keyboard: [
          [
            btn("➕ تخصیص جدید", "x:n:l"),
            btn("📋 سوابق تخصیص‌ها", "m:allocationhistory"),
          ],
          [btn("🏠 منوی اصلی", "m:home")],
        ],
      },
    );
  if (action === "goals")
    return editPanel(
      env,
      msg,
      "⏸ بخش اهداف مالی فعلاً غیرفعال است.",
      backHome(),
    );

  if (action === "home") {
    await cleanupMessages(env, chatId, msg.message_id);
    return editPanel(env, msg, mainMenuText(), mainMenuKeyboard());
  }
  if (action === "new") {
    return editPanel(
      env,
      msg,
      "➕ <b>ثبت تراکنش جدید</b>\nنوع را انتخاب کن: درآمد به حساب یا باکس اضافه می‌شود، هزینه از مبدأ پرداخت کم می‌شود و انتقال، پول را از یک حساب به حساب دیگر جابه‌جا می‌کند.",
      txTypeKeyboard(),
    );
  }
  if (action === "help") return editPanel(env, msg, helpText(), backHome());
  if (action === "report") return showOverview(env, msg);
  if (action === "csv") return reportTableMenu(env, chatId, msg);
  if (action === "check")
    return editPanel(env, msg, await checkConnections(env), backHome());
}

function mainMenuText(extra = "") {
  return (
    `${extra ? esc(extra) + "\n\n" : ""}💳 <b>مدیریت مالی شخصی</b>\n\n` +
    `تراکنش ها، حساب‌ها، باکس‌ها و دارایی‌هایت را یک‌جا مدیریت کن.\n\n` +
    `برای شروع، یکی از گزینه‌های منو را انتخاب کن 👇`
  );
}

function helpText() {
  return (
    `💳 <b>مدیریت مالی شخصی</b>\n\n` +
    `<b>همه‌چیز درباره پولت، یکجا.</b>\n\n` +
    `سلام 👋\n` +
    `من دستیار مالی تو هستم؛ برای ثبت، مدیریت و تحلیل جریان پول و دارایی‌هات.\n\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `⚡ <b>دسترسی سریع</b>\n\n` +
    `💵 <b>ثبت درآمد</b>\nدریافتی جدیدت رو ثبت کن.\n\n` +
    `🔄 <b>تخصیص منابع</b>\nپولت رو بین بخش‌های مختلف تقسیم کن.\n\n` +
    `🛒 <b>ثبت هزینه</b>\nهزینه‌ای که انجام دادی رو ثبت کن.\n\n` +
    `📈 <b>ثبت سرمایه‌گذاری</b>\nخرید طلا، سهام، ارز یا سایر دارایی‌ها.\n\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `📊 <b>نمای کلی مالی</b>\n\n` +
    `💰 <b>موجودی کل</b>\nمجموع پول قابل استفاده\n\n` +
    `📦 <b>منابع</b>\nخرج روزانه · رابطه · سرمایه‌گذاری · تعیین‌تکلیف‌نشده\n\n` +
    `💎 <b>دارایی‌ها</b>\nارزش کل دارایی‌ها و سرمایه‌گذاری‌ها\n\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `🧭 <b>چه چیزی می‌خوای ببینی؟</b>\n\n` +
    `<code>📊 گزارش مالی</code>\n` +
    `<code>💸 هزینه‌ها</code>\n` +
    `<code>📈 سرمایه‌گذاری‌ها</code>\n` +
    `<code>💎 دارایی‌ها</code>\n` +
    `<code>📦 منابع مالی</code>\n\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `🔐 <b>ساده، دقیق، تحت کنترل تو</b>\n\n` +
    `هر تراکنش ثبت می‌شود،\n` +
    `هر تخصیص قابل پیگیری است،\n` +
    `و همیشه می‌توانی تصویر واقعی وضعیت مالی‌ات را ببینی.`
  );
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [btn("🏦 حساب‌ها", "m:accounts"), btn("📦 باکس‌ها", "m:boxes")],
      [
        btn("💳 تراکنش", "m:transactions"),
        btn("🎯 تخصیص منابع", "m:allocations"),
      ],
      [btn("💎 دارایی‌ها", "m:assets"), btn("🏷 دسته‌بندی‌ها", "m:categories")],
      [btn("📊 داشبورد مالی", "m:report"), btn("📤 دریافت گزارش", "m:csv")],
      [btn("⚙️ وضعیت سرویس‌ها", "m:check"), btn("📖 راهنما", "m:help")],
    ],
  };
}

function transactionsKeyboard() {
  return {
    inline_keyboard: [
      [btn("➕ تراکنش جدید", "m:new")],
      [btn("📒 سوابق تراکنش‌ها", "m:txhistory")],
      [btn("🏠 منوی اصلی", "m:home")],
    ],
  };
}

function sendMainMenu(env, chatId, extra = "") {
  return send(env, chatId, mainMenuText(extra), {
    reply_markup: mainMenuKeyboard(),
  });
}

function backHome() {
  return { inline_keyboard: [[btn("🏠 منوی اصلی", "m:home")]] };
}

function txTypeKeyboard() {
  return {
    inline_keyboard: [
      [btn("💸 هزینه", "tx:type:هزینه"), btn("💰 درآمد", "tx:type:درآمد")],
      [btn("🔁 انتقال", "tx:type:انتقال")],
      [btn("🏠 بازگشت", "m:home")],
    ],
  };
}

function amountUnitFactor(unit) {
  if (unit === "thousand") return 1_000;
  if (unit === "million") return 1_000_000;
  return 0;
}

function scaledAmountPrompt(factor) {
  if (factor === 1_000_000)
    return "💰 مبلغ را به <b>میلیون تومان</b> وارد کن.\n\nمثلاً برای ۳۲ میلیون تومان، عدد <code>۳۲</code> را وارد کن.";
  return "💰 مبلغ را به <b>هزار تومان</b> وارد کن.\n\nمثلاً برای ۵۰۰ هزار تومان، عدد <code>۵۰۰</code> را وارد کن.";
}

function amountReplyNotice() {
  return "✍️ لطفاً مبلغ را در پیام پاسخ‌گویی که برایت باز می‌شود وارد کن.";
}

function scaledAmountError(factor) {
  return `❌ یک عددِ مثبت و بدون واحد وارد کن. عدد باید بر اساس واحد انتخابی (${factor === 1_000_000 ? "میلیون" : "هزار"} تومان) باشد؛ مثلاً <code>${factor === 1_000_000 ? "۳۲" : "۵۰۰"}</code>.`;
}

async function showMoneyUnitChoice(
  env,
  chatId,
  msg,
  namespace,
  cancelCallback,
  title = "💰 واحد مبلغ را انتخاب کن:",
  extraRows = [],
) {
  return panel(env, chatId, msg, title, {
    inline_keyboard: [
      [
        btn("هزار تومان", `${namespace}:unit:thousand`),
        btn("میلیون تومان", `${namespace}:unit:million`),
      ],
      ...extraRows.filter((row) => row.length),
      [btn("❌ لغو", cancelCallback)],
    ],
  });
}

function sendScaledAmountPrompt(env, chatId, factor) {
  return send(env, chatId, scaledAmountPrompt(factor), {
    reply_markup: {
      force_reply: true,
      input_field_placeholder:
        factor === 1_000_000 ? "مثلاً ۳۲ یا ۱٫۵" : "مثلاً ۵۰۰ یا ۱٫۵",
    },
  });
}

function parseScaledAmount(text, factor) {
  if (![1_000, 1_000_000].includes(factor)) return NaN;
  const normalized = toEnDigits(String(text).trim()).replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return NaN;
  const value = Number(normalized);
  if (!(value > 0)) return NaN;
  return Math.round(value * factor * RIAL_PER_TOMAN);
}

function parsePercentInput(text) {
  const normalized = toEnDigits(String(text).trim())
    .replace(/[٪%]/g, "")
    .replace(/,/g, "")
    .trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return NaN;
  return Number(normalized);
}

function sendAmountReview(env, chatId, amount, confirmAction, editAction) {
  return send(
    env,
    chatId,
    `💰 <b>مبلغ واردشده</b>\n\n<b>${fmt(amount)} تومان</b>\n\nاگر مبلغ درست است تأیید کن تا به مرحله‌ی بعد بروی؛ برای ورود دوباره، اصلاح را بزن.`,
    {
      reply_markup: {
        inline_keyboard: [
          [btn("✅ تأیید", confirmAction), btn("✏️ اصلاح", editAction)],
        ],
      },
    },
  );
}

/* ============================== Transaction flow ============================== */

async function handleTxCallback(env, msg, action, args) {
  const chatId = msg.chat.id;
  let state = await getState(env, chatId);

  if (action === "type") {
    const type = args.join(":");
    if (!TYPE_META[type]) return;
    state = {
      flow: "tx",
      step: "title",
      draft: { type, status: "ثبت‌شده", currency: DEFAULT_CURRENCY },
    };
    await setState(env, chatId, state);
    await editPanel(
      env,
      msg,
      `${TYPE_META[type].icon} <b>ثبت ${esc(type)}</b>\n\nدر چند مرحله عنوان، مبلغ و جزئیات این تراکنش را می‌گیریم. هرجا لازم باشد می‌توانی آن مرحله را رد یا عملیات را لغو کنی.`,
      { inline_keyboard: [[btn("❌ لغو", "tx:cancel")]] },
    );
    const example = type === "درآمد"
      ? "حقوق مهرماه"
      : type === "انتقال"
        ? "انتقال به حساب پس‌انداز"
        : "خرید هفتگی";
    return send(env, chatId, `📝 یک عنوان کوتاه برای ${esc(type)} وارد کن؛ این عنوان بعداً در سوابق و گزارش‌ها دیده می‌شود.\nمثلاً: <code>${example}</code>`, {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "مثلاً خرید روزانه",
      },
    });
  }

  if (action === "cancel") {
    await clearState(env, chatId);
    await cleanupMessages(env, chatId, msg.message_id);
    return editPanel(
      env,
      msg,
      mainMenuText("عملیات لغو شد."),
      mainMenuKeyboard(),
    );
  }

  if (!state || state.flow !== "tx") {
    return editPanel(
      env,
      msg,
      "این عملیات منقضی شده. از منوی اصلی دوباره شروع کن.",
      backHome(),
    );
  }

  if (action === "desc-skip" && state.step === "description-input") {
    state.draft.desc = "";
    state.descriptionDone = true;
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state, msg);
  }

  if (action === "amount") {
    const toman = Number(args[0]);
    if (!(toman > 0)) return;
    state.draft.amount = Math.round(toman * RIAL_PER_TOMAN);
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state, msg);
  }

  if (action === "unit") {
    state.moneyUnitFactor = amountUnitFactor(args[0]);
    if (!state.moneyUnitFactor) return;
    state.step = "amount-input";
    await setState(env, chatId, state);
    await editPanel(env, msg, amountReplyNotice(), {
      inline_keyboard: [[btn("❌ لغو", "tx:cancel")]],
    });
    return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
  }

  if (action === "amount-edit") {
    if (!state.moneyUnitFactor) state.moneyUnitFactor = 1_000;
    state.step = "amount-input";
    await setState(env, chatId, state);
    await editPanel(env, msg, amountReplyNotice(), {
      inline_keyboard: [[btn("❌ لغو", "tx:cancel")]],
    });
    return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
  }

  if (action === "source-edit") {
    const meta = TYPE_META[state.draft.type];
    delete state.draft.box;
    delete state.draft.fromAccount;
    state.draft.skipBox = false;
    await setState(env, chatId, state);
    if (meta.optionalBox)
      return choose(env, chatId, msg, "box", { optional: true });
    return choose(env, chatId, msg, "acc", { role: "from" });
  }

  if (action === "amount-ok" && state.step === "amount-review") {
    state.draft.amount = state.pendingAmount;
    delete state.pendingAmount;
    state.step = "amount-choice";
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state, msg);
  }

  if (action === "custom") {
    state.step = "amount-unit";
    await setState(env, chatId, state);
    return showMoneyUnitChoice(env, chatId, msg, "tx", "tx:cancel");
  }

  if (action === "skip") {
    const kind = args[0];
    if (kind === "box") state.draft.skipBox = true;
    if (kind === "cat") state.draft.skipCategory = true;
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state, msg);
  }

  if (action === "pg") {
    const [kind, role, page, exclude, optional] = args;
    return choose(env, chatId, msg, kind, {
      role: role === "-" ? undefined : role,
      page: Number(page) || 0,
      exclude: exclude === "-" ? undefined : exclude,
      optional: optional === "1",
    });
  }

  if (action === "acc") {
    const [role, id] = args;
    const a = (await listAccounts(env)).find((x) => idEq(x.id, id));
    if (!a) return;
    if (role === "from") state.draft.fromAccount = a;
    if (role === "to") state.draft.toAccount = a;
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state, msg);
  }

  if (action === "box") {
    const x = (await listBoxes(env)).find((b) => idEq(b.id, args[0]));
    if (!x) return;
    state.draft.box = x;
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state, msg);
  }

  if (action === "catpg") {
    return chooseCategoryRoot(
      env,
      chatId,
      msg,
      Number(args[0]) || 0,
      args[1] === "1",
      args[2] && args[2] !== "-" ? args[2] : null,
    );
  }

  if (action === "catgroups") {
    return chooseCategoryGroups(env, chatId, msg, args[0] === "1");
  }

  if (action === "catgroup") {
    return chooseCategoryRoot(env, chatId, msg, 0, args[1] === "1", args[0]);
  }

  if (action === "subpg") {
    return chooseCategoryChild(
      env,
      chatId,
      msg,
      args[0],
      Number(args[1]) || 0,
      args[2] === "1",
      args[3] && args[3] !== "-" ? args[3] : null,
    );
  }

  if (action === "catroot") {
    const categories = await transactionCategories(env, state);
    const x = categories.find((c) => idEq(c.id, args[0]));
    if (!x) return;
    state.draft.categoryRoot = x;
    await setState(env, chatId, state);
    return chooseCategoryChild(
      env,
      chatId,
      msg,
      compactId(x.id),
      0,
      args[1] === "1",
      args[2] || null,
    );
  }

  if (action === "catmain" || action === "cat") {
    const categories = await transactionCategories(env, state);
    const x = categories.find((c) => idEq(c.id, args[0]));
    if (!x) return;
    state.draft.category = x;
    delete state.draft.categoryRoot;
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state, msg);
  }

  if (action === "asset") {
    const x = (await listAssets(env)).find((a) => idEq(a.id, args[0]));
    if (!x) return;
    state.draft.asset = x;
    state.step = "assetQty";
    await setState(env, chatId, state);
    return send(
      env,
      chatId,
      `💎 مقدار «${esc(x.name)}» را وارد کن.\nمثال: 0.5`,
      {
        reply_markup: { force_reply: true, input_field_placeholder: "0.5" },
      },
    );
  }

  if (action === "date") {
    state.draft.date = addDays(state.draft.date, Number(args[0]));
    await setState(env, chatId, state);
    return sendTxConfirm(env, chatId, state, msg);
  }

  if (action === "save") {
    if (!(await ensureTransactionFunds(env, chatId, state, msg))) return;
    await saveTransaction(env, state.draft);
    await clearState(env, chatId);
    return editPanel(
      env,
      msg,
      `✅ <b>تراکنش ثبت شد</b>\n${esc(state.draft.title)}\nنوع: ${esc(state.draft.type)}\nمبلغ: <b>${fmt(state.draft.amount)} تومان</b>`,
      {
        inline_keyboard: [
          [btn("➕ تراکنش جدید", "m:new")],
          [btn("💳 تراکنش‌ها", "m:txhistory"), btn("🏠 منو", "m:home")],
        ],
      },
    );
  }
}

function askTxAmount(env, chatId, state) {
  return showMoneyUnitChoice(
    env,
    chatId,
    null,
    "tx",
    "tx:cancel",
    `💵 <b>مبلغ تراکنش «${esc(state.draft.title)}»</b>\nواحدی را انتخاب کن که می‌خواهی مبلغ را با آن وارد کنی. در مرحله‌ی بعد عدد را می‌فرستی؛ مثلاً ۵۰۰ با واحد هزار یعنی ۵۰۰ هزار تومان.`,
  );
}

async function continueTxFlow(env, chatId, state, msg = null) {
  const d = state.draft;
  const meta = TYPE_META[d.type];

  if (d.type === "درآمد" && !d.box && !d.skipBox) {
    const unallocated = await getUnallocatedBox(env);
    if (unallocated) d.box = unallocated;
  }

  if (meta.optionalBox && !d.box && !d.skipBox)
    return choose(env, chatId, msg, "box", { optional: true });

  const boxReplacesAccount = Boolean(d.box && meta.optionalBox);
  if (meta.accountMode === "from" && !d.fromAccount && !boxReplacesAccount)
    return choose(env, chatId, msg, "acc", { role: "from" });
  if (meta.accountMode === "to" && !d.toAccount && !boxReplacesAccount)
    return choose(env, chatId, msg, "acc", { role: "to" });
  if (meta.accountMode === "both") {
    if (!d.fromAccount)
      return choose(env, chatId, msg, "acc", { role: "from" });
    if (!d.toAccount)
      return choose(env, chatId, msg, "acc", {
        role: "to",
        exclude: compactId(d.fromAccount.id),
      });
  }

  if (!(await ensureTransactionFunds(env, chatId, state, msg))) return;

  if (d.accountCharge && !state.descriptionDone) {
    state.step = "description-input";
    await setState(env, chatId, state);
    return panel(env, chatId, msg, "📝 توضیحی برای این شارژ بنویس تا بعداً در سوابق تراکنش قابل‌تشخیص باشد. اگر توضیحی نداری، رد کردن را بزن.", {
      inline_keyboard: [
        [btn("⏭ رد کردن توضیحات", "tx:desc-skip")],
        [btn("❌ لغو", "tx:cancel")],
      ],
    });
  }

  if (meta.needsBox && !d.box) return choose(env, chatId, msg, "box");
  if (meta.needsCategory && !d.category)
    return chooseCategoryRoot(env, chatId, msg);
  if (meta.optionalCategory && !d.category && !d.skipCategory)
    return chooseCategoryRoot(env, chatId, msg, 0, true);
  if (meta.needsAsset && !d.asset) return choose(env, chatId, msg, "ast");

  if (meta.needsAsset && !d.assetQty) {
    state.step = "assetQty";
    await setState(env, chatId, state);
    return send(env, chatId, "مقدار دارایی را وارد کن:", {
      reply_markup: { force_reply: true },
    });
  }

  state.step = "confirm";
  await setState(env, chatId, state);
  return sendTxConfirm(env, chatId, state, msg);
}

async function ensureTransactionFunds(env, chatId, state, msg = null) {
  const d = state.draft;
  const meta = TYPE_META[d.type];
  if (!(d.amount > 0) || !["from", "both"].includes(meta.accountMode))
    return true;

  let balance;
  let sourceName;
  if (d.box && meta.optionalBox) {
    balance = await getBoxBalance(env, d.box.id);
    sourceName = `باکس «${d.box.name}»`;
  } else if (d.fromAccount) {
    balance = await getAccountBalance(env, d.fromAccount.id);
    sourceName = `حساب «${d.fromAccount.name}»`;
  } else {
    return true;
  }
  if (d.amount <= balance) return true;

  state.step = "insufficient-funds";
  await setState(env, chatId, state);
  await panel(
    env,
    chatId,
    msg,
    `❌ موجودی ${sourceName} برای این پرداخت کافی نیست؛ تراکنش هنوز ثبت نشده است.\nمبلغ تراکنش: <b>${fmt(d.amount)} تومان</b>\nموجودی فعلی: <b>${fmt(balance)} تومان</b>\n\nحساب یا باکس را شارژ کن، یا مبلغ/منبع پرداخت را تغییر بده.`,
    {
      inline_keyboard: [
        [btn("✏️ تغییر مبلغ", "tx:amount-edit")],
        [btn("🔄 تغییر منبع پرداخت", "tx:source-edit")],
        [btn("❌ لغو", "tx:cancel")],
      ],
    },
  );
  return false;
}

// انتخابگر عمومی با صفحه‌بندی (حساب / باکس / دسته‌بندی / دارایی)
async function choose(
  env,
  chatId,
  msg,
  kind,
  { role, exclude, page = 0, optional = false } = {},
) {
  const cfg = {
    acc: {
      list: () => listAccounts(env),
      icon: "🏦",
      text:
        role === "to"
          ? "🏦 حسابی را انتخاب کن که مبلغ به آن اضافه می‌شود؛ این حساب مقصد تراکنش است."
          : "🏦 حسابی را انتخاب کن که مبلغ از آن پرداخت می‌شود؛ موجودی این حساب کاهش پیدا می‌کند.",
      cb: (id) => `tx:acc:${role}:${id}`,
    },
    box: {
      list: async () => await listBoxes(env),
      icon: "📦",
      text: "📦 اگر مبلغ این تراکنش از یک باکس پرداخت می‌شود یا باید به باکسی اضافه شود، آن باکس را انتخاب کن. در غیر این صورت «رد کردن این مرحله» را بزن تا از حساب استفاده شود.",
      cb: (id) => `tx:box:${id}`,
    },
    ast: {
      list: () => listAssets(env),
      icon: "💎",
      text: "💎 دارایی را انتخاب کن:",
      cb: (id) => `tx:asset:${id}`,
    },
  }[kind];
  if (!cfg) return;

  let items = await cfg.list();
  if (exclude) items = items.filter((a) => !idEq(a.id, exclude));
  const pages = Math.max(1, Math.ceil(items.length / PICK_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = items.slice(page * PICK_SIZE, (page + 1) * PICK_SIZE);

  const rows = chunk(
    slice.map((x) => btn(`${cfg.icon} ${x.name}`, cfg.cb(compactId(x.id)))),
    2,
  );
  if (pages > 1) {
    const nav = [];
    const mk = (p) =>
      `tx:pg:${kind}:${role || "-"}:${p}:${exclude || "-"}:${optional ? "1" : "0"}`;
    if (page > 0) nav.push(btn("◀️ قبلی", mk(page - 1)));
    nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
    if (page < pages - 1) nav.push(btn("بعدی ▶️", mk(page + 1)));
    rows.push(nav);
  }
  if (optional) rows.push([btn("⏭ رد کردن این مرحله", `tx:skip:${kind}`)]);
  rows.push([btn("❌ لغو", "tx:cancel")]);
  return panel(env, chatId, msg, cfg.text, { inline_keyboard: rows });
}

async function chooseCategoryRoot(
  env,
  chatId,
  msg,
  page = 0,
  optional = false,
  group = null,
) {
  const all = await transactionCategories(env, await getState(env, chatId));
  if (!group) return chooseCategoryGroups(env, chatId, msg, optional);
  const explicitRoots = all.filter((x) => x.level === "کلی");
  const allRoots = explicitRoots.length
    ? explicitRoots
    : all.filter((x) => !x.parentIds.length);
  const roots = allRoots.filter((root) => categoryRootBelongsToGroup(root, all, group));
  const pages = Math.max(1, Math.ceil(roots.length / PICK_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = roots.slice(page * PICK_SIZE, (page + 1) * PICK_SIZE);
  const rows = chunk(
    slice.map((x) =>
      btn(
        `${x.icon} ${x.name}`,
        `tx:catroot:${compactId(x.id)}:${optional ? "1" : "0"}:${group}`,
      ),
    ),
    2,
  );

  if (pages > 1) {
    const nav = [];
    if (page > 0)
      nav.push(btn("◀️ قبلی", `tx:catpg:${page - 1}:${optional ? "1" : "0"}:${group}`));
    nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
    if (page < pages - 1)
      nav.push(btn("بعدی ▶️", `tx:catpg:${page + 1}:${optional ? "1" : "0"}:${group}`));
    rows.push(nav);
  }
  if (optional) rows.push([btn("⏭ ثبت بدون دسته‌بندی", "tx:skip:cat")]);
  rows.push([btn("🔙 انتخاب گروه", `tx:catgroups:${optional ? "1" : "0"}`)]);
  rows.push([btn("❌ لغو", "tx:cancel")]);
  const text = roots.length
    ? `🏷 <b>دسته‌بندی‌های ${categoryBrowseGroupLabel(group)}</b>\nدسته‌ی کلی را انتخاب کن. بعد می‌توانی یک زیردسته را بزنی یا با همان دسته‌ی کلی ادامه بدهی:`
    : "⚠️ در این گروه دسته‌ی کلی پیدا نشد.";
  return panel(env, chatId, msg, text, { inline_keyboard: rows });
}

async function chooseCategoryGroups(env, chatId, msg, optional = false) {
  const state = await getState(env, chatId);
  const all = await transactionCategories(env, state);
  const explicitRoots = all.filter((x) => x.level === "کلی");
  const roots = explicitRoots.length
    ? explicitRoots
    : all.filter((x) => !x.parentIds.length);
  const groups = categoryBrowseGroups(all, roots).filter(
    (group) => !(state?.flow === "tx" && state.draft?.type === "هزینه" && group === "income"),
  );
  const rows = chunk(
    groups.map((group) =>
      btn(categoryBrowseGroupLabel(group), `tx:catgroup:${group}:${optional ? "1" : "0"}`),
    ),
    2,
  );
  if (optional) rows.push([btn("⏭ ثبت بدون دسته‌بندی", "tx:skip:cat")]);
  rows.push([btn("❌ لغو", "tx:cancel")]);
  return panel(env, chatId, msg,
    groups.length
      ? "🏷 <b>انتخاب گروه دسته‌بندی</b>\nگروهی را انتخاب کن که این تراکنش به آن مربوط است؛ بعد دسته‌ی کلی و در صورت نیاز زیردسته را مشخص می‌کنی."
      : "⚠️ دسته‌بندی فعالی پیدا نشد.",
    { inline_keyboard: rows });
}

async function chooseCategoryChild(
  env,
  chatId,
  msg,
  rootId,
  page = 0,
  optional = false,
  group = null,
) {
  const all = await transactionCategories(env, await getState(env, chatId));
  const root = all.find((x) => idEq(x.id, rootId));
  if (!root) return chooseCategoryRoot(env, chatId, msg, 0, optional, group);
  const children = all.filter((x) =>
    x.parentIds.some((id) => idEq(id, root.id)) &&
    (!group || categoryChildBelongsToGroup(x, root, group)),
  );

  const pages = Math.max(1, Math.ceil(children.length / PICK_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = children.slice(page * PICK_SIZE, (page + 1) * PICK_SIZE);
  const rows = [
    [
      btn(
        `✅ ${root.icon} ثبت با «${trunc(root.name, 26)}»`,
        `tx:catmain:${compactId(root.id)}`,
      ),
    ],
  ];
  rows.push(
    ...chunk(
      slice.map((x) => btn(`${x.icon} ${x.name}`, `tx:cat:${compactId(x.id)}`)),
      2,
    ),
  );
  if (pages > 1) {
    const nav = [];
    if (page > 0)
      nav.push(
        btn(
          "◀️ قبلی",
          `tx:subpg:${compactId(root.id)}:${page - 1}:${optional ? "1" : "0"}:${group || "-"}`,
        ),
      );
    nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
    if (page < pages - 1)
      nav.push(
        btn(
          "بعدی ▶️",
          `tx:subpg:${compactId(root.id)}:${page + 1}:${optional ? "1" : "0"}:${group || "-"}`,
        ),
      );
    rows.push(nav);
  }
  if (optional) rows.push([btn("⏭ ثبت بدون دسته‌بندی", "tx:skip:cat")]);
  rows.push([btn("🔙 دسته‌های کلی", `tx:catpg:0:${optional ? "1" : "0"}:${group || "-"}`)]);
  rows.push([btn("🔙 انتخاب گروه", `tx:catgroups:${optional ? "1" : "0"}`)]);
  rows.push([btn("❌ لغو", "tx:cancel")]);
  return panel(
    env,
    chatId,
    msg,
    children.length
      ? `${esc(root.icon)} <b>${esc(root.name)}</b>\nیک زیر‌دسته را انتخاب کن یا ادامه را با همین دسته‌بندی بزن:`
      : `${esc(root.icon)} <b>${esc(root.name)}</b>\nاین دسته زیر‌دسته‌ای ندارد؛ می‌توانی با همین دسته‌بندی ادامه بدهی.`,
    { inline_keyboard: rows },
  );
}

async function sendTxConfirm(env, chatId, state, msg = null) {
  const d = state.draft;
  const boxReplacesAccount = Boolean(d.box && TYPE_META[d.type].optionalBox);
  const lines = [
    `${TYPE_META[d.type].icon} <b>مرور و ثبت تراکنش</b>`,
    "",
    "عنوان، مبلغ، مبدأ یا مقصد و دسته‌بندی را بررسی کن. با زدن «ثبت»، تراکنش در سوابق مالی ذخیره می‌شود؛ دکمه‌های تاریخ هم روز ثبت را تغییر می‌دهند.",
    "",
    `نوع: ${esc(d.type)}`,
    `عنوان: ${esc(d.title)}`,
    `مبلغ: <b>${fmt(d.amount)} تومان</b>`,
    d.fromAccount && !boxReplacesAccount
      ? `از حساب: ${esc(d.fromAccount.name)}`
      : null,
    d.toAccount && !boxReplacesAccount
      ? `به حساب: ${esc(d.toAccount.name)}`
      : null,
    d.box ? `باکس: ${esc(d.box.name)}` : null,
    d.category
      ? `دسته‌بندی: ${d.category.icon ? `${esc(d.category.icon)} ` : ""}${esc(d.category.name)}`
      : null,
    d.asset ? `دارایی: ${esc(d.asset.name)} (${fa(d.assetQty)})` : null,
    d.unitPrice ? `قیمت واحد: ${fmt(d.unitPrice)} تومان` : null,
    d.desc ? `توضیحات: ${esc(d.desc)}` : null,
    `تاریخ: ${jalaliStr(d.date)}`,
  ].filter(Boolean);

  const kb = {
    inline_keyboard: [
      [btn("✅ ثبت", "tx:save")],
      [btn("📅 روز قبل", "tx:date:-1"), btn("📅 روز بعد", "tx:date:1")],
      [btn("❌ لغو", "tx:cancel")],
    ],
  };
  return panel(env, chatId, msg, lines.join("\n"), kb);
}

async function saveTransaction(env, d) {
  const boxReplacesAccount = Boolean(d.box && TYPE_META[d.type].optionalBox);
  const props = {
    [TX.title]: titleProp(d.title),
    [TX.type]: selectProp(d.type),
    [TX.amount]: { number: d.amount },
    [TX.currency]: selectProp(d.currency || DEFAULT_CURRENCY),
    [TX.date]: { date: { start: d.date } },
    [TX.status]: selectProp("ثبت‌شده"),
  };
  if (d.fromAccount && !boxReplacesAccount)
    props[TX.fromAccount] = relationProp(d.fromAccount.id);
  if (d.toAccount && !boxReplacesAccount)
    props[TX.toAccount] = relationProp(d.toAccount.id);
  if (d.category) props[TX.category] = relationProp(d.category.id);
  if (d.box) props[TX.box] = relationProp(d.box.id);
  if (d.asset) props[TX.asset] = relationProp(d.asset.id);
  if (d.assetQty) props[TX.assetQty] = { number: d.assetQty };
  if (d.unitPrice) props[TX.unitPrice] = { number: d.unitPrice };
  if (d.desc) props[TX.desc] = richTextProp(d.desc);
  if (TYPE_META[d.type].chart)
    props[TX.chartGroup] = selectProp(TYPE_META[d.type].chart);

  const res = await notion(env, "POST", "/pages", {
    parent: { database_id: dbId(env, "transactions") },
    properties: props,
  });
  return res.id;
}

/* ============================== Allocation flow ============================== */

async function startAllocation(env, msg) {
  try {
    await ensureAllocationAccountSchema(env);
  } catch (e) {
    return editPanel(
      env,
      msg,
      `❌ مدل تخصیص حساب ↔ باکس آماده نشد: ${esc(e.message)}\nدسترسی اتصال Notion به پایگاه‌داده حساب‌ها و تخصیص‌ها را بررسی کن.`,
      backHome(),
    );
  }
  const state = {
    flow: "allocation",
    step: "mode",
    draft: { date: todayTehran(), status: "ثبت‌شده" },
  };
  await setState(env, msg.chat.id, state);
  return editPanel(
    env,
    msg,
    "🎯 <b>انتقال بین حساب و باکس</b>\nجهت انتقال را انتخاب کن:",
    {
      inline_keyboard: [
        [btn("🏦 حساب به باکس", "al:assign")],
        [btn("📦 باکس به حساب", "al:release")],
        [btn("🏠 منوی اصلی", "m:home")],
      ],
    },
  );
}

async function handleAllocationCallback(env, msg, action, args) {
  const chatId = msg.chat.id;
  if (action === "start-box")
    return startBoxAllocation(env, msg, args[0]);
  const state = await getState(env, chatId);

  if (action === "cancel") {
    await clearState(env, chatId);
    await cleanupMessages(env, chatId, msg.message_id);
    return editPanel(
      env,
      msg,
      mainMenuText("عملیات لغو شد."),
      mainMenuKeyboard(),
    );
  }
  if (!state || state.flow !== "allocation") {
    return editPanel(env, msg, "این عملیات منقضی شده.", backHome());
  }

  if (action === "assign" && state.step === "mode") {
    state.draft.operation = "assign";
    state.step = "from-account";
    await setState(env, chatId, state);
    return allocationChooseAccount(env, msg, "from-account");
  }

  if (action === "release" && state.step === "mode") {
    state.draft.operation = "release";
    state.step = "from-box";
    await setState(env, chatId, state);
    return allocationChooseBox(env, msg, "from");
  }

  if (action === "unit" && state.step === "amount-unit") {
    state.moneyUnitFactor = amountUnitFactor(args[0]);
    if (!state.moneyUnitFactor) return;
    state.step = "amount-input";
    await setState(env, chatId, state);
    await editPanel(env, msg, amountReplyNotice(), {
      inline_keyboard: [[btn("❌ لغو", "al:cancel")]],
    });
    return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
  }

  if (action === "amount-edit" && state.step === "amount-review") {
    if (![1_000, 1_000_000].includes(state.moneyUnitFactor)) {
      state.step = "release-options";
      await setState(env, chatId, state);
      return editPanel(
        env,
        msg,
        `↩️ <b>انتقال از ${esc(state.draft.fromBox.name)} به ${esc(state.draft.toAccount.name)}</b>\nموجودی فعلی: <b>${fmt(state.maxAmount)} تومان</b>\n\nمقدار انتقال را انتخاب کن:`,
        {
          inline_keyboard: [
            [btn("انتقال کل موجودی", "al:full")],
            [btn("تعیین مبلغ", "al:amount")],
            [btn("تعیین درصد", "al:percent")],
            [btn("❌ لغو", "al:cancel")],
          ],
        },
      );
    }
    state.step = "amount-input";
    await setState(env, chatId, state);
    await editPanel(env, msg, amountReplyNotice(), {
      inline_keyboard: [[btn("❌ لغو", "al:cancel")]],
    });
    return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
  }

  if (action === "amount-ok" && state.step === "amount-review") {
    state.draft.amount = state.pendingAmount;
    delete state.pendingAmount;
    state.step = "confirm";
    await setState(env, chatId, state);
    return sendAllocationConfirm(env, chatId, state, msg);
  }

  if (
    action === "from" &&
    state.step === "from-box" &&
    state.draft.operation === "release"
  ) {
    const source = (await listBoxes(env)).find((x) => idEq(x.id, args[0]));
    if (!source) return;
    state.draft.fromBox = source;
    state.maxAmount = await getBoxBalance(env, source.id);
    if (!(state.maxAmount > 0))
      return editPanel(
        env,
        msg,
        `📦 «${esc(source.name)}» موجودی قابل انتقال ندارد.`,
        backHome(),
      );
    state.step = "to-account";
    await setState(env, chatId, state);
    return allocationChooseAccount(env, msg, "to-account");
  }

  if (
    action === "account" &&
    ["from-account", "to-account"].includes(state.step)
  ) {
    const account = (await listAccounts(env)).find((x) => idEq(x.id, args[0]));
    if (!account) return;
    if (state.step === "from-account") {
      state.draft.fromAccount = account;
      state.maxAmount = await getAccountBalance(env, account.id);
      if (!(state.maxAmount > 0))
        return editPanel(
          env,
          msg,
          `🏦 «${esc(account.name)}» موجودی قابل انتقال ندارد.`,
          backHome(),
        );
      if (state.draft.toBox) {
        state.step = "amount-unit";
        await setState(env, chatId, state);
        return showMoneyUnitChoice(env, chatId, msg, "al", "al:cancel");
      }
      state.step = "to-box";
      await setState(env, chatId, state);
      return allocationChooseBox(env, msg, "to", null, state.maxAmount);
    }
    state.draft.toAccount = account;
    state.step = "release-options";
    await setState(env, chatId, state);
    return editPanel(
      env,
      msg,
      `↩️ <b>انتقال از ${esc(state.draft.fromBox.name)} به ${esc(account.name)}</b>\nموجودی قابل انتقال: <b>${fmt(state.maxAmount)} تومان</b>\n\nمقدار را انتخاب کن:`,
      {
        inline_keyboard: [
          [btn("انتقال کل موجودی", "al:full")],
          [btn("تعیین مبلغ", "al:amount")],
          [btn("تعیین درصد", "al:percent")],
          [btn("❌ لغو", "al:cancel")],
        ],
      },
    );
  }

  if (
    action === "to" &&
    state.step === "to-box" &&
    state.draft.operation === "assign"
  ) {
    const target = (await listBoxes(env)).find((x) => idEq(x.id, args[0]));
    if (!target) return;
    state.draft.toBox = target;
    state.step = "amount-unit";
    await setState(env, chatId, state);
    return showMoneyUnitChoice(env, chatId, msg, "al", "al:cancel");
  }

  if (action === "full" && state.step === "release-options") {
    state.pendingAmount = state.maxAmount;
    state.step = "amount-review";
    await setState(env, chatId, state);
    return sendAmountReview(
      env,
      chatId,
      state.pendingAmount,
      "al:amount-ok",
      "al:amount-edit",
    );
  }

  if (action === "amount" && state.step === "release-options") {
    state.step = "amount-unit";
    await setState(env, chatId, state);
    return showMoneyUnitChoice(env, chatId, msg, "al", "al:cancel");
  }

  if (action === "percent" && state.step === "release-options") {
    state.step = "percent-input";
    await setState(env, chatId, state);
    await editPanel(
      env,
      msg,
      "درصدی از موجودی مبدأ را برای انتقال وارد کن.\nمثلاً <code>۲۵</code> یعنی ۲۵٪:",
      { inline_keyboard: [[btn("❌ لغو", "al:cancel")]] },
    );
    return send(env, chatId, "درصد را وارد کن 👇", {
      reply_markup: { force_reply: true, input_field_placeholder: "مثلاً ۲۵" },
    });
  }

  if (action === "save") {
    const d = state.draft;
    const complete =
      d.operation === "assign"
        ? d.fromAccount && d.toBox
        : d.fromBox && d.toAccount;
    if (state.step !== "confirm" || !complete)
      return editPanel(
        env,
        msg,
        "جزئیات تخصیص کامل نیست. عملیات را دوباره شروع کن.",
        backHome(),
      );
    const available =
      d.operation === "assign"
        ? await getAccountBalance(env, d.fromAccount.id)
        : await getBoxBalance(env, d.fromBox.id);
    if (available < state.draft.amount)
      return editPanel(
        env,
        msg,
        `موجودی مبدأ کافی نیست. موجودی فعلی: <b>${fmt(available)} تومان</b>`,
        backHome(),
      );
    await saveAllocation(env, state.draft);
    await clearState(env, chatId);
    return editPanel(env, msg, "✅ انتقال بین حساب و باکس ثبت شد.", {
      inline_keyboard: [
        [btn("🎯 تخصیص جدید", "x:n:l")],
        [
          btn("📋 سوابق تخصیص‌ها", "m:allocationhistory"),
          btn("🏠 منو", "m:home"),
        ],
      ],
    });
  }
}

async function startBoxAllocation(env, msg, boxId) {
  const chatId = msg.chat.id;
  try {
    await ensureAllocationAccountSchema(env);
  } catch (e) {
    return editPanel(
      env,
      msg,
      `❌ مدل تخصیص حساب ↔ باکس آماده نشد: ${esc(e.message)}\nدسترسی اتصال Notion به پایگاه‌داده حساب‌ها و تخصیص‌ها را بررسی کن.`,
      backHome(),
    );
  }
  const target = (await listBoxes(env)).find((box) => idEq(box.id, boxId));
  if (!target)
    return editPanel(env, msg, "این باکس پیدا نشد یا دیگر در دسترس نیست.", {
      inline_keyboard: [[btn("🔙 فهرست باکس‌ها", "x:l:b:0")]],
    });
  await setState(env, chatId, {
    flow: "allocation",
    step: "from-account",
    draft: {
      operation: "assign",
      toBox: target,
      date: todayTehran(),
      status: "ثبت‌شده",
    },
  });
  return allocationChooseAccount(env, msg, "from-account");
}

async function allocationChooseBox(env, msg, role, exclude, available = null) {
  const rows = (await listBoxes(env))
    .filter((x) => !exclude || !idEq(x.id, exclude))
    .map((x) => btn(`📦 ${x.name}`, `al:${role}:${compactId(x.id)}`));
  if (!rows.length)
    return editPanel(
      env,
      msg,
      "📦 برای این عملیات باکس دیگری در دسترس نیست.",
      backHome(),
    );
  return editPanel(
    env,
    msg,
    role === "from"
      ? "↩️ کدام باکس مبدأ انتقال به حساب است؟"
      : `🎯 مبلغ را به کدام باکس منتقل کنم؟${available === null ? "" : `\nموجودی حساب مبدأ: <b>${fmt(available)} تومان</b>`}`,
    {
      inline_keyboard: [
        ...chunk(rows.slice(0, 80), 2),
        [btn("❌ لغو", "al:cancel")],
      ],
    },
  );
}

async function allocationChooseAccount(env, msg, role) {
  const rows = (await listAccounts(env)).map((x) =>
    btn(`🏦 ${x.name}`, `al:account:${compactId(x.id)}`),
  );
  if (!rows.length)
    return editPanel(
      env,
      msg,
      "🏦 حساب فعالی برای انتقال پیدا نشد.",
      backHome(),
    );
  return editPanel(
    env,
    msg,
    role === "from-account"
      ? "🏦 حساب مبدأ را انتخاب کن:"
      : "🏦 حساب مقصد را انتخاب کن:",
    {
      inline_keyboard: [
        ...chunk(rows.slice(0, 80), 2),
        [btn("❌ لغو", "al:cancel")],
      ],
    },
  );
}

function sendAllocationConfirm(env, chatId, state, msg = null) {
  const d = state.draft;
  const fromLabel =
    d.operation === "assign" ? d.fromAccount.name : d.fromBox.name;
  const toLabel = d.operation === "assign" ? d.toBox.name : d.toAccount.name;
  return panel(
    env,
    chatId,
    msg,
    `🔄 <b>تأیید انتقال</b>\n\nاز: ${esc(fromLabel)}\nبه: ${esc(toLabel)}\nمبلغ: <b>${fmt(d.amount)} تومان</b>`,
    {
      inline_keyboard: [
        [btn("✅ ثبت انتقال", "al:save")],
        [btn("❌ لغو", "al:cancel")],
      ],
    },
  );
}

async function saveAllocation(env, d) {
  const fromName =
    d.operation === "assign" ? d.fromAccount.name : d.fromBox.name;
  const toName = d.operation === "assign" ? d.toBox.name : d.toAccount.name;
  const props = {
    [ALC.title]: titleProp(`${fromName} → ${toName}`),
    [ALC.amount]: { number: d.amount },
    [ALC.date]: { date: { start: d.date } },
    [ALC.status]: selectProp("ثبت‌شده"),
  };
  if (d.operation === "assign") {
    props[ALC.fromAccount] = relationProp(d.fromAccount.id);
    props[ALC.toBox] = relationProp(d.toBox.id);
  } else {
    props[ALC.fromBox] = relationProp(d.fromBox.id);
    props[ALC.toAccount] = relationProp(d.toAccount.id);
  }
  // Notion syncs the box's reciprocal «ورودی» / «خروجی» relation fields.
  const allocation = await notion(env, "POST", "/pages", {
    parent: { database_id: dbId(env, "allocations") },
    properties: props,
  });
  try {
    const txProps = {
      [TX.title]: titleProp(`${fromName} به ${toName}`),
      [TX.type]: selectProp("انتقال"),
      [TX.amount]: { number: d.amount },
      [TX.currency]: selectProp(DEFAULT_CURRENCY),
      [TX.date]: { date: { start: d.date } },
      [TX.status]: selectProp("ثبت‌شده"),
    };
    if (d.operation === "assign") {
      txProps[TX.fromAccount] = relationProp(d.fromAccount.id);
      txProps[TX.box] = relationProp(d.toBox.id);
    } else {
      txProps[TX.toAccount] = relationProp(d.toAccount.id);
      txProps[TX.box] = relationProp(d.fromBox.id);
    }
    await notion(env, "POST", "/pages", {
      parent: { database_id: dbId(env, "transactions") },
      properties: txProps,
    });
  } catch (e) {
    try {
      await notion(env, "PATCH", `/pages/${allocation.id}`, { archived: true });
    } catch {}
    throw e;
  }
  return allocation.id;
}

/* ============================== CRUD (schema-driven) ============================== */

async function handleCrud(env, msg, action, args) {
  const chatId = msg.chat.id;

  if (["l", "v", "e", "f", "d", "D", "n"].includes(action) && args[0] === "g") {
    await clearState(env, chatId);
    return editPanel(
      env,
      msg,
      "⏸ بخش اهداف مالی فعلاً غیرفعال است.",
      backHome(),
    );
  }

  if (action === "ca") {
    await clearState(env, chatId);
    return listCategoryChildren(env, chatId, msg, args[0], 0, args[1] || null);
  }
  if (action === "cg") {
    await clearState(env, chatId);
    return listCategoryRoots(env, chatId, msg, 0, args[0]);
  }
  if (action === "cs") {
    await clearState(env, chatId);
    return listCategoryChildren(
      env,
      chatId,
      msg,
      args[0],
      Number(args[1]) || 0,
      args[2] || null,
    );
  }
  if (action === "cp") {
    await clearState(env, chatId);
    const parentId = args[0] === "-" ? null : args[0];
    const page = Number(args[1]) || 0;
    const group = args[2] || null;
    return parentId
      ? listCategoryChildren(env, chatId, msg, parentId, page, group)
      : listCategoryRoots(env, chatId, msg, page, group);
  }

  if (["l", "v", "e", "d", "D", "n", "x", "charge"].includes(action))
    await clearState(env, chatId);

  if (action === "x") {
    await cleanupMessages(env, chatId, msg.message_id);
    return editPanel(
      env,
      msg,
      mainMenuText("عملیات لغو شد."),
      mainMenuKeyboard(),
    );
  }
  if (action === "l")
    return listEntity(env, chatId, msg, args[0], Number(args[1]) || 0);
  if (action === "v") return showItem(env, chatId, msg, args[0], args[1]);

  if (action === "charge") {
    const entity = args.length > 1 ? args[0] : "a";
    const id = args.length > 1 ? args[1] : args[0];
    const target = entity === "b"
      ? (await listBoxes(env)).find((x) => idEq(x.id, id))
      : (await listAccounts(env)).find((x) => idEq(x.id, id));
    if (!target) return listEntity(env, chatId, msg, entity === "b" ? "b" : "a", 0);
    const targetName = entity === "b" ? "باکس" : "حساب";
    await setState(env, chatId, {
      flow: "tx",
      step: "title",
      draft: {
        type: "درآمد",
        status: "ثبت‌شده",
        currency: DEFAULT_CURRENCY,
        ...(entity === "b" ? { box: target } : { toAccount: target }),
        skipBox: true,
        accountCharge: true,
      },
    });
    await editPanel(env, msg, `💰 شارژ ${targetName} «${esc(target.name)}»`, {
      inline_keyboard: [[btn("❌ لغو", "tx:cancel")]],
    });
    return send(env, chatId, `📝 عنوان این درآمد را وارد کن؛ این تراکنش مستقیماً به ${targetName} «${esc(target.name)}» اضافه می‌شود و عنوانش در سوابق آن دیده خواهد شد.\nمثلاً: <code>واریز به ${targetName}</code>`, {
      reply_markup: { force_reply: true, input_field_placeholder: "مثلاً واریز حقوق" },
    });
  }

  if (action === "n") {
    const e = args[0];
    if (e === "t")
      return editPanel(
        env,
        msg,
        "➕ <b>ثبت تراکنش جدید</b>\nنوع را انتخاب کن: درآمد به حساب یا باکس اضافه می‌شود، هزینه از مبدأ پرداخت کم می‌شود و انتقال، پول را از یک حساب به حساب دیگر جابه‌جا می‌کند.",
        txTypeKeyboard(),
      );
    if (e === "l") return startAllocation(env, msg);
    if (e === "s") return listEntity(env, chatId, msg, "s", 0);
    if (e === "c") return startNewCategory(env, chatId, msg, args[1], args[2]);
    return startNew(env, chatId, msg, e);
  }

  if (action === "e") {
    const [e, id] = args;
    const schema = await getSchema(env, ENT[e].key);
    let editable = schema.editable;
    if (e === "c") {
      const categories = await listCategories(env, true);
      const hasChildren = categories.some((x) =>
        x.parentIds.some((parentId) => idEq(parentId, id)),
      );
      editable = editable.filter((p) => categoryHierarchyField(p.name) !== "level");
      if (hasChildren) editable = editable.filter((p) => categoryHierarchyField(p.name) !== "parent");
    }
    const rows = editable.map((p) => {
      const i = schema.editable.indexOf(p);
      return [btn(`✏️ ${categoryFieldLabel(e, p)}`, `x:f:${e}:${id}:${i}`)];
    });
    rows.push([btn("🔙 بازگشت", `x:v:${e}:${id}`)]);
    return editPanel(env, msg, "✏️ کدام فیلد را ویرایش کنم؟", {
      inline_keyboard: rows,
    });
  }

  if (action === "f") {
    const [e, id, idx] = args;
    const schema = await getSchema(env, ENT[e].key);
    const p = schema.editable[Number(idx)];
    if (!p) return;
    const st = {
      flow: "edit",
      ent: e,
      pageId: id,
      propName: p.name,
      step: "value",
    };
    return askField(env, chatId, msg, st, p, "edit");
  }

  if (action === "d") {
    const [e, id] = args;
    const boxWarning = e === "b"
      ? `\n\n⚠️ با حذف این باکس، مانده‌ی آن (${fmt(await getBoxBalance(env, id))} تومان) وارد حساب اصلی می‌شود.`
      : "";
    const categoryChildren = e === "c"
      ? await categoryDescendants(env, id)
      : [];
    const categoryWarning = categoryChildren.length
      ? `\n\n⚠️ ${fa(categoryChildren.length)} زیر‌دسته هم همراه این دسته از نُوشن حذف می‌شود.`
      : "";
    return editPanel(
      env,
      msg,
      `🗑 مطمئنی این رکورد حذف شود؟${boxWarning}${categoryWarning}\n\n(در Notion به سطل زباله می‌رود و تا ۳۰ روز قابل بازیابی است.)`,
      {
        inline_keyboard: [
          [btn("🗑 بله، حذف کن", `x:D:${e}:${id}`)],
          [btn("🔙 نه", `x:v:${e}:${id}`)],
        ],
      },
    );
  }

  if (action === "D") {
    const [e, id] = args;
    let transferred = 0;
    let mainAccount = null;
    let deletedCategoryChildren = 0;
    if (e === "b") {
      transferred = await getBoxBalance(env, id);
      if (transferred > 0) {
        mainAccount = await findMainAccount(env);
        if (!mainAccount)
          return editPanel(
            env,
            msg,
            "❌ حساب اصلی مشخصی پیدا نشد؛ باکس حذف نشد و مانده‌اش دست‌نخورده ماند. نام یا نوع حساب اصلی را در فهرست حساب‌ها مشخص کن.",
            { inline_keyboard: [[btn("🔙 بازگشت", `x:v:b:${id}`)]] },
          );
        await ensureAllocationAccountSchema(env);
        await saveAllocation(env, {
          operation: "move",
          fromBox: { id, name: propTitle(await notion(env, "GET", `/pages/${id}`), BOX.title) },
          toAccount: mainAccount,
          amount: transferred,
          date: todayTehran(),
        });
      }
    }
    if (e === "c") {
      const descendants = await categoryDescendants(env, id);
      try {
        for (const child of descendants) {
          await notion(env, "PATCH", `/pages/${child.id}`, { archived: true });
          deletedCategoryChildren += 1;
        }
      } catch (error) {
        console.error("Failed to archive category descendants", error);
        const detail = deletedCategoryChildren
          ? `تا اینجا ${fa(deletedCategoryChildren)} زیر‌دسته حذف شده؛ دستهٔ کلی حذف نشد.`
          : "هیچ دسته‌ای حذف نشد و دستهٔ کلی دست‌نخورده ماند.";
        return editPanel(env, msg, `❌ حذف کامل دسته‌ها انجام نشد. ${detail} دوباره تلاش کن.`, {
          inline_keyboard: [[btn("🔙 بازگشت", `x:v:c:${id}`)]],
        });
      }
    }
    await notion(env, "PATCH", `/pages/${id}`, { archived: true });
    const deletedText = transferred > 0
      ? `✅ باکس حذف شد و ${fmt(transferred)} تومان به حساب اصلی «${esc(mainAccount.name)}» منتقل شد.`
      : e === "c" && deletedCategoryChildren > 0
        ? `✅ دسته و ${fa(deletedCategoryChildren)} زیر‌دستهٔ آن از نُوشن حذف شدند.`
        : "✅ رکورد حذف شد.";
    return editPanel(env, msg, deletedText, {
      inline_keyboard: [
        [btn(`📋 فهرست ${ENT[e].fa}`, `x:l:${e}:0`)],
        [btn("🏠 منو", "m:home")],
      ],
    });
  }

  // --- اکشن‌هایی که به state وابسته‌اند ---
  const st = await getState(env, chatId);
  if (!st || (st.flow !== "edit" && st.flow !== "new")) {
    return editPanel(
      env,
      msg,
      "این عملیات منقضی شده. از منوی اصلی دوباره شروع کن.",
      backHome(),
    );
  }
  if (st.flow === "new" && st.assetFlow)
    return handleAssetCreateCallback(env, msg, st, action, args);
  const schema = await getSchema(env, ENT[st.ent].key);
  const p = schema.props.find((x) => x.name === st.propName);

  if (action === "unit" && p && isMoneyField(st.ent, p.name)) {
    st.moneyUnitFactor = amountUnitFactor(args[0]);
    if (!st.moneyUnitFactor) return;
    st.step = "money-input";
    await setState(env, chatId, st);
    await editPanel(env, msg, amountReplyNotice(), {
      inline_keyboard: [
        [
          btn(
            "❌ لغو",
            st.flow === "new" ? "x:x" : `x:v:${st.ent}:${st.pageId}`,
          ),
        ],
      ],
    });
    return sendScaledAmountPrompt(env, chatId, st.moneyUnitFactor);
  }
  if (action === "money-edit" && p && st.pendingMoney) {
    st.step = "money-input";
    await setState(env, chatId, st);
    await editPanel(env, msg, amountReplyNotice(), {
      inline_keyboard: [
        [
          btn(
            "❌ لغو",
            st.flow === "new" ? "x:x" : `x:v:${st.ent}:${st.pageId}`,
          ),
        ],
      ],
    });
    return sendScaledAmountPrompt(env, chatId, st.moneyUnitFactor);
  }
  if (action === "money-ok" && p && st.pendingMoney) {
    const amount = st.pendingMoney.number;
    delete st.pendingMoney;
    return setFieldValue(env, chatId, msg, st, { number: amount }, fmt(amount));
  }
  if (st.ent === "g") {
    await clearState(env, chatId);
    return editPanel(
      env,
      msg,
      "⏸ بخش اهداف مالی فعلاً غیرفعال است.",
      backHome(),
    );
  }

  if (action === "o" && p) {
    const name = st.opts?.[Number(args[0])];
    if (name === undefined) return;
    const payload =
      p.type === "select"
        ? { select: { name } }
        : p.type === "status"
          ? { status: { name } }
          : { multi_select: [{ name }] };
    return setFieldValue(env, chatId, msg, st, payload, name);
  }
  if (action === "r" && p) {
    const o = st.opts?.[Number(args[0])];
    if (!o) return;
    return setFieldValue(
      env,
      chatId,
      msg,
      st,
      { relation: [{ id: o.id }] },
      o.name,
    );
  }
  if (action === "c" && p) {
    const v = args[0] === "1";
    return setFieldValue(
      env,
      chatId,
      msg,
      st,
      { checkbox: v },
      v ? "✅" : "⬜",
    );
  }
  if (action === "z" && p) {
    if (st.flow === "new") {
      st.pos += 1;
      return advanceNew(env, chatId, msg, st);
    }
    return setFieldValue(env, chatId, msg, st, emptyPayload(p), "—");
  }
  if (action === "w" && st.flow === "new") {
    const res = await notion(env, "POST", "/pages", {
      parent: { database_id: dbId(env, ENT[st.ent].key) },
      properties: st.props,
    });
    await clearState(env, chatId);
    return showItem(
      env,
      chatId,
      msg,
      st.ent,
      compactId(res.id),
      "✅ رکورد ایجاد شد.",
    );
  }
}

async function listEntity(env, chatId, msg, e, page = 0) {
  if (e === "c") return listCategoryRoots(env, chatId, msg, page);
  const ent = ENT[e];
  const sorts = ent.date
    ? [
        { property: ent.date, direction: "descending" },
        { timestamp: "created_time", direction: "descending" },
      ]
    : [{ timestamp: "created_time", direction: "ascending" }];
  const rows = await queryDb(env, ent.key, {
    sorts,
    limit: (page + 1) * PAGE_SIZE + 1,
  });
  const hasNext = rows.length > (page + 1) * PAGE_SIZE;
  const slice = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const buttons = await Promise.all(
    slice.map(async (p) => {
      const rawName = propTitle(p, ent.title) || "بدون عنوان";
      const name = e === "l"
        ? rawName.replace(/→/g, "\u200E←\u200E")
        : rawName;
      const brief = await briefOf(env, e, p);
      return [
        btn(
          trunc(
            `${brief.icon} ${name}${brief.text ? " · " + brief.text : ""}`,
            58,
          ),
          `x:v:${e}:${compactId(p.id)}`,
        ),
      ];
    }),
  );

  const nav = [];
  if (page > 0) nav.push(btn("◀️ قبلی", `x:l:${e}:${page - 1}`));
  if (hasNext) nav.push(btn("بعدی ▶️", `x:l:${e}:${page + 1}`));

  const kb = [...buttons];
  if (nav.length) kb.push(nav);
  if (e !== "s")
    kb.push([btn(`➕ ${ent.one} جدید`, `x:n:${e}`), btn("📤 CSV", `r:t:${e}`)]);
  kb.push([btn("🏠 منوی اصلی", "m:home")]);

  const text =
    `${ent.icon} <b>${esc(ent.fa)}</b> — صفحه ${fa(page + 1)}\n` +
    (slice.length
      ? "برای مشاهده، ویرایش یا حذف روی یک مورد بزن 👇"
      : "موردی ثبت نشده.");
  return panel(env, chatId, msg, text, { inline_keyboard: kb });
}

async function listCategoryRoots(env, chatId, msg, page = 0, group = null) {
  const all = await listCategories(env, true);
  const explicitRoots = all.filter((x) => x.level === "کلی");
  const allRoots = explicitRoots.length
    ? explicitRoots
    : all.filter((x) => !x.parentIds.length);
  if (!group) {
    const groups = categoryBrowseGroups(all, allRoots);
    const rows = chunk(
      groups.map((key) => btn(categoryBrowseGroupLabel(key), `x:cg:${key}`)),
      2,
    );
    rows.push([btn("🏠 منوی اصلی", "m:home")]);
    return panel(env, chatId, msg,
      "🏷 <b>دسته‌بندی‌ها</b>\nدسته‌بندی‌های کدام گروه را می‌خواهی ببینی؟",
      { inline_keyboard: rows });
  }

  const roots = allRoots.filter((root) => categoryRootBelongsToGroup(root, all, group));
  const pages = Math.max(1, Math.ceil(roots.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = roots.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = slice.map((root) => {
    const status = root.active ? "" : " (غیرفعال)";
    return [btn(`${root.icon} ${root.name}${status}`, `x:ca:${compactId(root.id)}:${group}`)];
  });
  const nav = [];
  if (page > 0) nav.push(btn("◀️ قبلی", `x:cp:-:${page - 1}:${group}`));
  if (pages > 1) nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
  if (page < pages - 1) nav.push(btn("بعدی ▶️", `x:cp:-:${page + 1}:${group}`));
  if (nav.length) rows.push(nav);
  rows.push([btn("➕ افزودن دسته‌ی کلی", `x:n:c:${group}`)]);
  rows.push([btn("🔙 انتخاب گروه", "x:l:c:0")]);
  rows.push([btn("🏠 منوی اصلی", "m:home")]);
  return panel(env, chatId, msg,
    `🏷 <b>دسته‌بندی‌های ${categoryBrowseGroupLabel(group)}</b>\nدسته‌ی کلی را انتخاب کن:`,
    { inline_keyboard: rows });
}

async function showCategoryRoot(env, chatId, msg, rootId, group = null) {
  const all = await listCategories(env, true);
  const root = all.find((x) => idEq(x.id, rootId));
  if (!root) return listCategoryRoots(env, chatId, msg, 0, group);
  const groupArg = group || categoryGroupForRoot(root, all) || "other";
  const rows = [
    [btn("📂 مشاهده زیر‌دسته‌ها", `x:cs:${compactId(root.id)}:0:${groupArg}`)],
    [btn("✏️ ویرایش همین دسته", `x:e:c:${compactId(root.id)}`)],
    [btn("🗑 حذف همین دسته", `x:d:c:${compactId(root.id)}`)],
    [btn("🔙 دسته‌های کلی", `x:cg:${groupArg}`)],
  ];
  return panel(env, chatId, msg,
    `${root.icon} <b>${esc(root.name)}</b>${root.active ? "" : "\nوضعیت: غیرفعال"}\nبرای دیدن زیر‌دسته‌ها، گزینه‌ی زیر را انتخاب کن.`,
    { inline_keyboard: rows });
}

async function listCategoryChildren(env, chatId, msg, rootId, page = 0, group = null) {
  const all = await listCategories(env, true);
  const root = all.find((x) => idEq(x.id, rootId));
  if (!root) return listCategoryRoots(env, chatId, msg, 0, group);
  const groupArg = group || categoryGroupForRoot(root, all) || "other";
  const children = all.filter((x) =>
    x.parentIds.some((id) => idEq(id, root.id)) &&
    categoryRootBelongsToGroup(root, all, groupArg) &&
    categoryChildBelongsToGroup(x, root, groupArg),
  );
  const pages = Math.max(1, Math.ceil(children.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = children.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = slice.map((child) => [
    btn(`${child.icon} ${child.name}${child.active ? "" : " (غیرفعال)"}`, `x:v:c:${compactId(child.id)}`),
  ]);
  const nav = [];
  if (page > 0) nav.push(btn("◀️ قبلی", `x:cp:${compactId(root.id)}:${page - 1}:${groupArg}`));
  if (pages > 1) nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
  if (page < pages - 1) nav.push(btn("بعدی ▶️", `x:cp:${compactId(root.id)}:${page + 1}:${groupArg}`));
  if (nav.length) rows.push(nav);
  rows.push([
    btn("✏️ ویرایش دسته", `x:e:c:${compactId(root.id)}`),
    btn("🗑 حذف دسته", `x:d:c:${compactId(root.id)}`),
  ]);
  rows.push([btn("➕ افزودن زیر‌دسته", `x:n:c:${groupArg}:${compactId(root.id)}`)]);
  rows.push([btn("🔙 بازگشت به دسته‌های کلی", `x:cg:${groupArg}`)]);
  return panel(env, chatId, msg,
    `${root.icon} <b>${esc(root.name)}</b>\nزیر‌دسته‌ها را انتخاب کن:`,
    { inline_keyboard: rows });
}

function categoryBrowseGroupLabel(group) {
  return ({ income: "💰 درآمدی", investment: "📈 سرمایه‌گذاری", expense: "💸 هزینه‌ای", other: "🏷 سایر" })[group] || "🏷 سایر";
}

function categoryBrowseGroups(all, roots) {
  const groups = new Set();
  for (const root of roots) {
    const children = all.filter((x) => x.parentIds.some((id) => idEq(id, root.id)));
    const rootGroup = categoryGroupForRoot(root, all);
    if (rootGroup !== "other") groups.add(rootGroup);
    else if (children.length) {
      for (const child of children) {
        const kind = categoryGroupKind(child.group);
        groups.add(kind || "other");
      }
    } else groups.add("other");
  }
  return ["income", "investment", "expense", "other"].filter((x) => groups.has(x));
}

function categoryGroupForRoot(root, all) {
  const direct = categoryGroupKind(root.group) || categoryGroupKind(root.name);
  if (direct) return direct;
  const children = all.filter((x) => x.parentIds.some((id) => idEq(id, root.id)));
  const kinds = [...new Set(children.map((x) => categoryGroupKind(x.group)).filter(Boolean))];
  return kinds.length === 1 ? kinds[0] : "other";
}

function categoryRootBelongsToGroup(root, all, group) {
  const direct = categoryGroupKind(root.group) || categoryGroupKind(root.name);
  if (direct) return direct === group;
  const childGroups = all
    .filter((x) => x.parentIds.some((id) => idEq(id, root.id)))
    .map((x) => categoryGroupKind(x.group))
    .filter(Boolean);
  if (childGroups.length) return childGroups.includes(group);
  return group === "other";
}

function categoryChildBelongsToGroup(child, root, group) {
  const kind = categoryGroupKind(child.group);
  return (kind || group) === group;
}

async function briefOf(env, e, p) {
  if (e === "t") {
    const type = propChoice(p, TX.type);
    return {
      icon: TYPE_META[type]?.icon || "•",
      text: `${fmt(propNumber(p, TX.amount))} ت`,
    };
  }
  if (e === "l")
    return { icon: "🎯", text: `${fmt(propNumber(p, ALC.amount))} ت` };
  if (e === "a")
    return {
      icon: "🏦",
      text: `${fmt(await exactNumber(env, p, ACC.balance))} ت`,
    };
  if (e === "b")
    return {
      icon: "📦",
      text: `${fmt(await exactNumber(env, p, BOX.balance))} ت`,
    };
  if (e === "s")
    return {
      icon: "💎",
      text: `${fmt(await exactNumber(env, p, AST.value))} ت`,
    };
  if (e === "g") {
    const target = propNumber(p, GOL.target);
    const al = await exactNumber(env, p, GOL.allocated);
    return {
      icon: "🏁",
      text: target
        ? `${fa(Math.min(100, Math.round((al / target) * 100)))}٪`
        : "",
    };
  }
  if (e === "c") return { icon: pageEmoji(p, ""), text: "" };
  return { icon: "🏷", text: "" };
}

async function showItem(env, chatId, msg, e, id, note = "") {
  const ent = ENT[e];
  const [schema, page] = await Promise.all([
    getSchema(env, ent.key),
    notion(env, "GET", `/pages/${id}`),
  ]);

  if (page.archived) {
    return panel(env, chatId, msg, "این رکورد قبلاً حذف شده.", {
      inline_keyboard: [[btn("📋 فهرست", `x:l:${e}:0`)]],
    });
  }

  const relIds = [];
  for (const p of schema.props) {
    if (p.type === "relation")
      for (const r of page.properties?.[p.name]?.relation || [])
        relIds.push(r.id);
  }
  const rel = await relNames(env, relIds);

  const lines = [];
  if (note) lines.push(esc(note), "");
  const itemIcon = e === "c"
    ? categoryDisplayIcon(page)
    : ent.icon;
  lines.push(
    `${esc(itemIcon)} <b>${esc(propTitle(page, ent.title) || pageTitle(page) || "بدون عنوان")}</b>`,
    "",
  );

  for (const p of schema.props) {
    if (
      p.type === "title" ||
      isHiddenField(e, p) ||
      isHiddenAccountDetailField(e, p)
    )
      continue;
    const money = isMoneyField(e, p.name);
    let text;
    if (money && (p.type === "formula" || p.type === "rollup")) {
      text = fmt(await exactNumber(env, page, p.name));
    } else {
      text = cellText(page, p, { money, rel });
    }
    if (text === "") continue;
    lines.push(`${esc(categoryFieldLabel(e, p))}: <b>${esc(text)}</b>${money ? " تومان" : ""}`);
  }

  if (e === "g") {
    const target = propNumber(page, GOL.target);
    const al = await exactNumber(env, page, GOL.allocated);
    if (target) {
      const pct = Math.min(100, Math.round((al / target) * 100));
      lines.push("", `${progressBar(pct)} ${fa(pct)}٪`);
    }
  }

  const cid = compactId(id);
  const categoryParentId =
    e === "c" ? page.properties?.[CAT.parent]?.relation?.[0]?.id : null;
  const backToList =
    e === "c" && categoryParentId
      ? `x:cs:${compactId(categoryParentId)}:0`
      : `x:l:${e}:0`;
  const kb = {
    inline_keyboard: [
      ...(e === "a" ? [[btn("💰 شارژ حساب", `x:charge:a:${cid}`)]] : []),
      ...(e === "s" ? [[btn("📉 فروش این دارایی", `as:start:${cid}`)]] : []),
      ...(e === "b" ? [
        [btn("💰 شارژ باکس", `al:start-box:${cid}`)],
        [btn("➕ افزودن باکس جدید", "x:n:b")],
      ] : []),
      [btn("✏️ ویرایش", `x:e:${e}:${cid}`), btn("🗑 حذف", `x:d:${e}:${cid}`)],
      [btn("🔙 فهرست", backToList), btn("🏠 منو", "m:home")],
    ],
  };
  return panel(env, chatId, msg, lines.join("\n"), kb);
}

async function startAssetSale(env, chatId, msg, assetId) {
  const page = await notion(env, "GET", `/pages/${assetId}`);
  if (page.archived) return listEntity(env, chatId, msg, "s", 0);
  const asset = {
    id: page.id,
    name: propTitle(page, AST.title),
    qty: propNumber(page, AST.qty),
    price: propNumber(page, AST.price),
  };
  if (!(asset.qty > 0))
    return editPanel(env, msg, "مقدار فعلی این دارایی برای فروش صفر است.", {
      inline_keyboard: [[btn("🔙 بازگشت به دارایی", `x:v:s:${compactId(asset.id)}`)]],
    });
  const state = { flow: "asset-sale", step: "quantity", asset, date: todayTehran() };
  await setState(env, chatId, state);
  return panel(env, chatId, msg,
    `📉 فروش «${esc(asset.name)}»\nمقدار قابل فروش: <b>${fa(asset.qty)}</b>\nمقدار فروخته‌شده را وارد کن:`,
    { inline_keyboard: [[btn("❌ لغو", "as:cancel")]] });
}

async function handleAssetSaleText(env, chatId, state, text) {
  if (state.step === "quantity") {
    const quantity = Number(toEnDigits(text).replace(/,/g, ""));
    if (!(quantity > 0) || quantity > state.asset.qty)
      return send(env, chatId, `مقدار باید بیشتر از صفر و حداکثر ${fa(state.asset.qty)} باشد.`);
    state.quantity = quantity;
    state.step = "base-price";
    await setState(env, chatId, state);
    return send(env, chatId, "قیمت پایه‌ی هر واحد دارایی را به تومان وارد کن:", {
      reply_markup: { force_reply: true },
    });
  }
  if (state.step === "base-price" || state.step === "proceeds") {
    const amount = parseAmountStrict(text);
    if (!(amount > 0)) return send(env, chatId, "مبلغ باید بیشتر از صفر باشد؛ مبلغ را به تومان وارد کن.");
    if (state.step === "base-price") {
      state.basePrice = amount;
      state.step = "proceeds";
      await setState(env, chatId, state);
      return send(env, chatId, "مبلغ کل فروخته‌شده را به تومان وارد کن:", {
        reply_markup: { force_reply: true },
      });
    }
    state.proceeds = amount;
    state.step = "destination";
    await setState(env, chatId, state);
    return showAssetSaleDestinations(env, chatId, null, state);
  }
  return send(env, chatId, "برای ادامه از دکمه‌های پیام استفاده کن یا /cancel را بزن.");
}

async function showAssetSaleDestinations(env, chatId, msg, state) {
  const boxes = await listBoxes(env);
  const accounts = await listAccounts(env);
  const rows = [
    ...boxes.map((x) => [btn(`📦 ${x.name}`, `as:box:${compactId(x.id)}`)]),
    ...accounts.map((x) => [btn(`🏦 ${x.name}`, `as:account:${compactId(x.id)}`)]),
    [btn("❌ لغو", "as:cancel")],
  ];
  return panel(env, chatId, msg, "مبلغ فروش به کجا واریز شده؟ باکس یا حساب مقصد را انتخاب کن:", { inline_keyboard: rows });
}

async function handleAssetSaleCallback(env, msg, action, args) {
  const chatId = msg.chat.id;
  if (action === "start") return startAssetSale(env, chatId, msg, args[0]);
  const state = await getState(env, chatId);
  if (!state || state.flow !== "asset-sale")
    return editPanel(env, msg, "این عملیات منقضی شده. دوباره از صفحه‌ی دارایی شروع کن.", backHome());
  if (action === "cancel") {
    await clearState(env, chatId);
    return showItem(env, chatId, msg, "s", state.asset.id, "عملیات فروش لغو شد.");
  }
  if (action === "box" && state.step === "destination") {
    state.box = (await listBoxes(env)).find((x) => idEq(x.id, args[0]));
    if (!state.box) return;
  } else if (action === "account" && state.step === "destination") {
    state.account = (await listAccounts(env)).find((x) => idEq(x.id, args[0]));
    if (!state.account) return;
  } else if (action === "save" && state.step === "confirm") {
    const remaining = state.asset.qty - state.quantity;
    const transaction = {
      type: "فروش دارایی",
      title: `فروش ${state.asset.name}`,
      amount: state.proceeds,
      date: state.date,
      asset: { id: state.asset.id, name: state.asset.name },
      assetQty: state.quantity,
      unitPrice: Math.round(state.proceeds / state.quantity),
      desc: `قیمت پایه هر واحد: ${fmt(state.basePrice)} تومان`,
      box: state.box,
      toAccount: state.account,
      currency: DEFAULT_CURRENCY,
    };
    const properties = { [AST.qty]: { number: remaining } };
    if (state.asset.price > 0) properties[AST.value] = { number: Math.round(state.asset.price * remaining) };
    await notion(env, "PATCH", `/pages/${state.asset.id}`, { properties });
    try {
      await saveTransaction(env, transaction);
    } catch (error) {
      await notion(env, "PATCH", `/pages/${state.asset.id}`, {
        properties: {
          [AST.qty]: { number: state.asset.qty },
          ...(state.asset.price > 0 ? { [AST.value]: { number: Math.round(state.asset.price * state.asset.qty) } } : {}),
        },
      }).catch(() => {});
      throw error;
    }
    await clearState(env, chatId);
    return showItem(env, chatId, msg, "s", state.asset.id,
      `✅ فروش ثبت شد و ${fmt(state.proceeds)} تومان به ${state.box ? `باکس «${esc(state.box.name)}»` : `حساب «${esc(state.account.name)}»`} اضافه شد.`);
  } else return;
  state.step = "confirm";
  await setState(env, chatId, state);
  return panel(env, chatId, msg,
    `📉 <b>تأیید فروش دارایی</b>\nدارایی: ${esc(state.asset.name)}\nمقدار فروش: ${fa(state.quantity)} از ${fa(state.asset.qty)}\nقیمت پایه هر واحد: ${fmt(state.basePrice)} تومان\nمبلغ کل فروش: <b>${fmt(state.proceeds)} تومان</b>\nمقصد: ${esc(state.box?.name || state.account?.name)}\nمقدار باقی‌مانده: ${fa(state.asset.qty - state.quantity)}`,
    { inline_keyboard: [[btn("✅ ثبت فروش", "as:save")], [btn("❌ لغو", "as:cancel")]] });
}

/* ---- فیلدها: پرسیدن / دریافت مقدار ---- */

async function askField(env, chatId, msg, st, p, mode) {
  st.propName = p.name;
  st.opts = null;
  const displayName =
    st.ent === "a" && p.name === "مانده اولیه"
      ? "موجودی حساب"
      : categoryFieldLabel(st.ent, p);
  const head = `${mode === "new" ? "➕" : "✏️"} <b>${esc(displayName)}</b>`;
  const isMoney = p.type === "number" && isMoneyField(st.ent, p.name);

  const tail = [];
  if (mode === "new" && p.type !== "title") tail.push(btn("⏭ رد کردن", "x:z"));
  if (mode === "edit" && p.type !== "title")
    tail.push(btn("🧹 پاک کردن مقدار", "x:z"));
  const cancelRow = [
    btn("❌ لغو", mode === "new" ? "x:x" : `x:v:${st.ent}:${st.pageId}`),
  ];

  if (isMoney) {
    st.step = "money-unit";
    await setState(env, chatId, st);
    return showMoneyUnitChoice(
      env,
      chatId,
      msg,
      "x",
      cancelRow[0].callback_data,
      `💰 <b>${esc(displayName)}</b>\nواحد مبلغ را انتخاب کن:`,
      [tail],
    );
  }

  if (p.type === "select" || p.type === "status" || p.type === "multi_select") {
    st.opts = p.options || [];
    st.step = "choice";
    await setState(env, chatId, st);
    const rows = chunk(
      st.opts.map((o, i) => btn(o, `x:o:${i}`)),
      2,
    );
    return panel(env, chatId, msg, `${head}\nیک گزینه انتخاب کن:`, {
      inline_keyboard: [...rows, tail, cancelRow].filter((r) => r.length),
    });
  }

  if (p.type === "checkbox") {
    st.step = "choice";
    await setState(env, chatId, st);
    return panel(env, chatId, msg, head, {
      inline_keyboard: [
        [btn("✅ بله", "x:c:1"), btn("⬜ خیر", "x:c:0")],
        tail,
        cancelRow,
      ].filter((r) => r.length),
    });
  }

  if (p.type === "relation") {
    st.opts = await relationOptionsForField(env, st, p, "");
    st.step = "rel";
    await setState(env, chatId, st);
    const rows = chunk(
      st.opts.map((o, i) => btn(`🔗 ${o.name}`, `x:r:${i}`)),
      2,
    );
    return panel(
      env,
      chatId,
      msg,
      `${head}\nیکی را انتخاب کن، یا بخشی از نام را تایپ کن تا جستجو شود:`,
      {
        inline_keyboard: [...rows, tail, cancelRow].filter((r) => r.length),
      },
    );
  }

  // فیلدهای متنی/عددی/تاریخ
  const hints = {
    title: "عنوان را در پیام بعدی وارد کن.",
    rich_text: "متن را در پیام بعدی وارد کن.",
    number: isMoney
      ? "مبلغ را به <b>تومان</b> بفرست. مثال: <code>۵۵ هزار</code>، <code>2.5 میلیون</code> یا <code>۲ میلیون و پانصد</code>"
      : "یک عدد بفرست.",
    date: "تاریخ شمسی یا میلادی بفرست. مثال: <code>1405/07/12</code> یا <code>امروز</code>",
    url: "آدرس را بفرست.",
    email: "ایمیل را بفرست.",
    phone_number: "شماره را بفرست.",
  };
  if (st.ent === "a" && p.name === "مانده اولیه") {
    hints.number =
      "موجودی حساب را به <b>تومان</b> بفرست. مثال: <code>۲۵۰٬۰۰۰ تومان</code>";
  }
  if (st.ent === "b" && p.name === BOX.title) {
    hints.title =
      "برای باکس یک نام روشن و قابل‌تشخیص وارد کن؛ مثلاً <code>پس‌انداز سفر</code> یا <code>هزینه‌های خانه</code>.";
  }
  if (st.ent === "b" && p.name === "توضیحات باکس") {
    hints.rich_text =
      "اگر لازم است کاربرد یا هدف این باکس را توضیح بده تا بعداً راحت‌تر آن را از بقیه باکس‌ها تشخیص بدهی. اگر توضیحی نداری، یک خط تیره بفرست.";
  }
  st.step = "text";
  await setState(env, chatId, st);
  return panel(
    env,
    chatId,
    msg,
    `${head}\n${hints[p.type] || "مقدار را بفرست."}`,
    {
      inline_keyboard: [tail, cancelRow].filter((r) => r.length),
    },
  );
}

async function handleFieldText(env, chatId, st, text) {
  const schema = await getSchema(env, ENT[st.ent].key);
  const p = schema.props.find((x) => x.name === st.propName);
  if (!p) return send(env, chatId, "فیلد پیدا نشد. /cancel را بزن.");

  if (text.trim() === "-" && p.type !== "title") {
    if (st.flow === "new") {
      st.pos += 1;
      return advanceNew(env, chatId, null, st);
    }
    return setFieldValue(env, chatId, null, st, emptyPayload(p), "—");
  }

  if (st.step === "money-input" && isMoneyField(st.ent, p.name)) {
    const amount = parseScaledAmount(text, st.moneyUnitFactor);
    if (!(amount > 0))
      return send(env, chatId, scaledAmountError(st.moneyUnitFactor));
    st.pendingMoney = { number: amount };
    st.step = "money-review";
    await setState(env, chatId, st);
    return sendAmountReview(env, chatId, amount, "x:money-ok", "x:money-edit");
  }

  const r = parseFieldInput(st.ent, p, text);
  if (r.error) return send(env, chatId, `❌ ${esc(r.error)}`);
  return setFieldValue(env, chatId, null, st, r.payload, r.label);
}

async function handleRelationSearch(env, chatId, st, text) {
  const schema = await getSchema(env, ENT[st.ent].key);
  const p = schema.props.find((x) => x.name === st.propName);
  if (!p) return;
  st.opts = await relationOptionsForField(env, st, p, text.trim());
  await setState(env, chatId, st);
  if (!st.opts.length)
    return send(env, chatId, "چیزی پیدا نشد. دوباره تایپ کن یا /cancel.");
  const rows = chunk(
    st.opts.map((o, i) => btn(`🔗 ${o.name}`, `x:r:${i}`)),
    2,
  );
  return send(env, chatId, "نتیجه‌ی جستجو 👇", {
    reply_markup: { inline_keyboard: rows },
  });
}

async function setFieldValue(env, chatId, msg, st, payload, label) {
  if (st.flow === "edit") {
    await notion(env, "PATCH", `/pages/${st.pageId}`, {
      properties: { [st.propName]: payload },
    });
    if (
      st.ent === "t" &&
      (st.propName === TX.amount || st.propName === TX.assetQty)
    ) {
      await recomputeUnitPrice(env, st.pageId);
    }
    await clearState(env, chatId);
    return showItem(env, chatId, msg, st.ent, st.pageId, "✅ ذخیره شد.");
  }
  st.props = st.props || {};
  st.labels = st.labels || {};
  st.props[st.propName] = payload;
  st.labels[st.propName] = label;
  st.pos += 1;
  return advanceNew(env, chatId, msg, st);
}

async function recomputeUnitPrice(env, pageId) {
  const page = await notion(env, "GET", `/pages/${pageId}`);
  const qty = propNumber(page, TX.assetQty);
  const amount = propNumber(page, TX.amount);
  if (qty > 0 && amount > 0) {
    await notion(env, "PATCH", `/pages/${pageId}`, {
      properties: { [TX.unitPrice]: { number: Math.round(amount / qty) } },
    });
  }
}

async function startNewAsset(env, chatId, msg) {
  const schema = await getSchema(env, "assets");
  const typeField = schema.props.find((p) => p.name === AST.type);
  if (!typeField || !["select", "status"].includes(typeField.type))
    return editPanel(
      env,
      msg,
      `❌ فیلد «${esc(AST.type)}» در پایگاه‌داده دارایی‌ها برای انتخاب نوع آماده نیست.`,
      backHome(),
    );

  const fields = {
    title: schema.props.find((p) => p.name === AST.title),
    type: typeField,
    qty: schema.props.find((p) => p.name === AST.qty),
    price: schema.props.find((p) => p.name === AST.price),
    value: schema.props.find((p) => p.name === AST.value),
    description: schema.props.find(
      (p) => p.type === "rich_text" && /توضیح/.test(p.name),
    ),
    unit: schema.props.find((p) => p.name === AST.unit),
    symbol: schema.props.find((p) => p.name === AST.symbol),
    currency: schema.props.find((p) => p.name === AST.currency),
    updatedAt: schema.props.find(
      (p) => p.type === "date" && /بروزرسانی|به‌روزرسانی/.test(p.name),
    ),
    active: schema.props.find(
      (p) => p.name === AST.active && p.type === "checkbox",
    ),
  };
  if (!fields.title || !fields.qty || !fields.price || !fields.value)
    return editPanel(
      env,
      msg,
      "❌ فیلدهای عنوان، مقدار، قیمت فعلی و ارزش بازار در پایگاه‌داده دارایی‌ها کامل نیستند.",
      backHome(),
    );

  const state = {
    flow: "new",
    ent: "s",
    assetFlow: true,
    assetStep: "title",
    fields,
    types: typeField.options || [],
    asset: { date: todayTehran() },
  };
  await setState(env, chatId, state);
  return send(
    env,
    chatId,
    "💎 <b>ثبت دارایی جدید</b>\nابتدا عنوانی روشن برای دارایی وارد کن؛ مثلاً «دلار» یا «طلای ۱۸ عیار».",
    {
      reply_markup: {
        force_reply: true,
        input_field_placeholder: "مثلاً دلار",
      },
    },
  );
}

async function handleAssetCreateText(env, chatId, state, text) {
  const asset = state.asset;
  if (state.assetStep === "title") {
    if (!text || text.length > 200)
      return send(env, chatId, "عنوان دارایی باید بین ۱ تا ۲۰۰ نویسه باشد.");
    asset.title = text;
    state.assetStep = "description";
    await setState(env, chatId, state);
    return panel(
      env,
      chatId,
      null,
      "توضیحات دارایی را وارد کن؛ اگر توضیحی نداری «-» بفرست.",
      {
        inline_keyboard: [
          [btn("⏭ رد کردن توضیحات", "x:assetdescskip")],
          [btn("❌ لغو", "x:x")],
        ],
      },
    );
  }
  if (state.assetStep === "description") {
    asset.description = text === "-" ? "" : text.slice(0, 2000);
    state.assetStep = "type";
    await setState(env, chatId, state);
    return showAssetTypeChoices(env, chatId, null, state);
  }
  if (state.assetStep === "price-input") {
    const price = parseScaledAmount(text, state.moneyUnitFactor);
    if (!(price > 0))
      return send(env, chatId, scaledAmountError(state.moneyUnitFactor));
    asset.currentPrice = price;
    state.assetStep = "quantity";
    delete state.moneyUnitFactor;
    await setState(env, chatId, state);
    return send(
      env,
      chatId,
      `قیمت هر واحد ثبت شد: <b>${fmt(price)} تومان</b>.\nمقدار دارایی را وارد کن:`,
      {
        reply_markup: { force_reply: true, input_field_placeholder: "مثلاً ۷" },
      },
    );
  }
  if (state.assetStep === "quantity") {
    const qty = Number(toEnDigits(text).replace(/,/g, ""));
    if (!(qty > 0) || !Number.isFinite(qty))
      return send(
        env,
        chatId,
        "مقدار دارایی باید عددی بزرگ‌تر از صفر باشد؛ مثلاً <code>۰٫۵</code>.",
      );
    asset.qty = qty;
    state.assetStep = "cost-unit";
    await setState(env, chatId, state);
    return showMoneyUnitChoice(
      env,
      chatId,
      null,
      "x",
      "x:x",
      "💰 مبلغ نهایی خرید را به چه واحدی وارد می‌کنی؟ این مبلغ به‌عنوان هزینه‌ی تراکنش ثبت و از باکس یا حساب انتخابی کسر می‌شود:",
    );
  }
  if (state.assetStep === "cost-input") {
    const cost = parseScaledAmount(text, state.moneyUnitFactor);
    if (!(cost > 0))
      return send(env, chatId, scaledAmountError(state.moneyUnitFactor));
    asset.cost = cost;
    state.assetStep = "box";
    delete state.moneyUnitFactor;
    await setState(env, chatId, state);
    return showAssetFundingChoices(env, chatId, null, state);
  }
  return send(
    env,
    chatId,
    "برای ادامه از دکمه‌های پیام استفاده کن یا /cancel را بزن.",
  );
}

function showAssetTypeChoices(env, chatId, msg, state) {
  const options = state.types;
  if (!options.length)
    return panel(
      env,
      chatId,
      msg,
      "نوع دارایی در تنظیمات دیتابیس گزینه‌ای ندارد.",
      backHome(),
    );
  const rows = chunk(
    options.map((name, index) => btn(name, `x:assettype:${index}`)),
    2,
  );
  rows.push([btn("❌ لغو", "x:x")]);
  return panel(env, chatId, msg, "نوع دارایی را انتخاب کن:", {
    inline_keyboard: rows,
  });
}

async function showAssetFundingChoices(env, chatId, msg, state) {
  const boxes = await listBoxes(env);
  const rows = boxes.map((box) => [
    btn(`📦 ${box.name}`, `x:assetbox:${compactId(box.id)}`),
  ]);
  rows.push([btn("🏦 پرداخت از حساب", "x:assetskipbox")]);
  rows.push([btn("❌ لغو", "x:x")]);
  return panel(
    env,
    chatId,
    msg,
    "منبع پرداخت مبلغ خرید را انتخاب کن. با انتخاب باکس، مبلغ فقط از همان باکس کم می‌شود؛ در غیر این صورت حساب را انتخاب می‌کنی.",
    { inline_keyboard: rows },
  );
}

async function showAssetAccountChoices(env, chatId, msg) {
  const accounts = await listAccounts(env);
  const rows = accounts.map((account) => [
    btn(`🏦 ${account.name}`, `x:assetaccount:${compactId(account.id)}`),
  ]);
  rows.push([btn("❌ لغو", "x:x")]);
  if (!accounts.length)
    return panel(
      env,
      chatId,
      msg,
      "حساب فعالی برای ثبت هزینه‌ی خرید پیدا نشد.",
      backHome(),
    );
  return panel(env, chatId, msg, "هزینه‌ی خرید از کدام حساب پرداخت شد؟", {
    inline_keyboard: rows,
  });
}

async function handleAssetCreateCallback(env, msg, state, action, args) {
  const chatId = msg.chat.id;
  if (action === "assetdescskip" && state.assetStep === "description") {
    state.asset.description = "";
    state.assetStep = "type";
    await setState(env, chatId, state);
    return showAssetTypeChoices(env, chatId, msg, state);
  }
  if (
    action === "unit" &&
    ["price-unit", "cost-unit"].includes(state.assetStep)
  ) {
    const factor = amountUnitFactor(args[0]);
    if (!factor) return;
    state.moneyUnitFactor = factor;
    state.assetStep =
      state.assetStep === "price-unit" ? "price-input" : "cost-input";
    await setState(env, chatId, state);
    return sendScaledAmountPrompt(env, chatId, factor);
  }
  if (action === "assetcostedit" && state.assetStep === "insufficient-funds") {
    state.assetStep = "cost-unit";
    await setState(env, chatId, state);
    return showMoneyUnitChoice(
      env,
      chatId,
      msg,
      "x",
      "x:x",
      "واحد مبلغ نهایی خرید را انتخاب کن:",
    );
  }
  if (
    action === "assetsourceedit" &&
    state.assetStep === "insufficient-funds"
  ) {
    delete state.asset.box;
    delete state.asset.account;
    state.assetStep = "box";
    await setState(env, chatId, state);
    return showAssetFundingChoices(env, chatId, msg, state);
  }
  if (action === "assettype" && state.assetStep === "type") {
    const type = state.types[Number(args[0])];
    if (!type) return;
    state.asset.type = type;
    state.assetStep = "price-unit";
    await setState(env, chatId, state);
    return showMoneyUnitChoice(
      env,
      chatId,
      msg,
      "x",
      "x:x",
      "واحد قیمت فعلی هر واحد دارایی را انتخاب کن:",
    );
  }
  if (action === "assetbox" && state.assetStep === "box") {
    const box = (await listBoxes(env)).find((x) => idEq(x.id, args[0]));
    if (!box) return;
    state.asset.box = box;
    if (!(await ensureAssetPurchaseFunds(env, chatId, msg, state))) return;
    state.assetStep = "confirm";
    await setState(env, chatId, state);
    return sendAssetCreateConfirm(env, chatId, msg, state);
  }
  if (action === "assetskipbox" && state.assetStep === "box") {
    state.assetStep = "account";
    await setState(env, chatId, state);
    return showAssetAccountChoices(env, chatId, msg);
  }
  if (action === "assetaccount" && state.assetStep === "account") {
    const account = (await listAccounts(env)).find((x) => idEq(x.id, args[0]));
    if (!account) return;
    state.asset.account = account;
    if (!(await ensureAssetPurchaseFunds(env, chatId, msg, state))) return;
    state.assetStep = "confirm";
    await setState(env, chatId, state);
    return sendAssetCreateConfirm(env, chatId, msg, state);
  }
  if (action === "assetsave" && state.assetStep === "confirm")
    return saveNewAssetAndPurchase(env, chatId, msg, state);
}

function sendAssetCreateConfirm(env, chatId, msg, state) {
  const a = state.asset;
  const value = Math.round(a.currentPrice * a.qty);
  const lines = [
    "💎 <b>تأیید ثبت دارایی و خرید</b>",
    "",
    `عنوان: ${esc(a.title)}`,
    a.description ? `توضیحات: ${esc(a.description)}` : null,
    `نوع: ${esc(a.type)}`,
    `قیمت فعلی هر واحد: <b>${fmt(a.currentPrice)} تومان</b>`,
    `مقدار: <b>${fa(a.qty)}</b>`,
    `ارزش روز دارایی: <b>${fmt(value)} تومان</b>`,
    `هزینه‌ی نهایی خرید: <b>${fmt(a.cost)} تومان</b>`,
    a.box
      ? `پرداخت از باکس: ${esc(a.box.name)}`
      : `پرداخت از حساب: ${esc(a.account?.name || "")}`,
    `تاریخ دارایی و تراکنش: ${jalaliStr(a.date)}`,
  ].filter(Boolean);
  return panel(env, chatId, msg, lines.join("\n"), {
    inline_keyboard: [
      [btn("✅ ثبت دارایی و تراکنش خرید", "x:assetsave")],
      [btn("❌ لغو", "x:x")],
    ],
  });
}

async function saveNewAssetAndPurchase(env, chatId, msg, state) {
  const a = state.asset;
  if (!(await ensureAssetPurchaseFunds(env, chatId, msg, state))) return;
  const fields = state.fields;
  const typeField = fields.type;
  const properties = {
    [fields.title.name]: titleProp(a.title),
    [fields.qty.name]: { number: a.qty },
    [fields.price.name]: { number: a.currentPrice },
  };
  properties[AST.type] =
    typeField.type === "status"
      ? { status: { name: a.type } }
      : selectProp(a.type);
  if (fields.description && a.description)
    properties[fields.description.name] = richTextProp(a.description);
  if (fields.value?.type === "number")
    properties[fields.value.name] = {
      number: Math.round(a.currentPrice * a.qty),
    };
  if (fields.active) properties[AST.active] = { checkbox: true };
  if (fields.updatedAt)
    properties[fields.updatedAt.name] = { date: { start: a.date } };
  if (fields.symbol?.type === "rich_text") {
    const normalizedTitle = a.title.replace(/\s+/g, "");
    const symbol = /دلار/.test(normalizedTitle)
      ? "USD"
      : /یورو/.test(normalizedTitle)
        ? "EUR"
        : /پوند/.test(normalizedTitle)
          ? "GBP"
          : /طلا/.test(normalizedTitle)
            ? "XAU"
            : null;
    if (symbol) properties[fields.symbol.name] = richTextProp(symbol);
  }
  if (fields.currency?.type === "select") {
    const currency = fields.currency.options?.includes(DEFAULT_CURRENCY)
      ? DEFAULT_CURRENCY
      : fields.currency.options?.includes("تومان")
        ? "تومان"
        : null;
    if (currency) properties[fields.currency.name] = selectProp(currency);
  }
  if (fields.unit) {
    const unit = /سکه/.test(a.title)
      ? "عدد"
      : /طلا/.test(a.title)
        ? "گرم"
        : "واحد";
    if (fields.unit.type === "rich_text")
      properties[fields.unit.name] = richTextProp(unit);
    if (fields.unit.type === "select" && fields.unit.options?.includes(unit))
      properties[fields.unit.name] = selectProp(unit);
  }

  const assetPage = await notion(env, "POST", "/pages", {
    parent: { database_id: dbId(env, "assets") },
    properties,
  });
  try {
    const purchase = {
      type: "خرید دارایی",
      title: `خرید ${a.title}`,
      amount: a.cost,
      date: a.date,
      asset: { id: assetPage.id, name: a.title },
      assetQty: a.qty,
      unitPrice: Math.round(a.cost / a.qty),
      box: a.box,
      fromAccount: a.account,
      currency: DEFAULT_CURRENCY,
    };
    await saveTransaction(env, purchase);
  } catch (error) {
    try {
      await notion(env, "PATCH", `/pages/${assetPage.id}`, { archived: true });
    } catch {}
    throw error;
  }
  await clearState(env, chatId);
  return editPanel(
    env,
    msg,
    `✅ دارایی «${esc(a.title)}» و تراکنش خرید ${fmt(a.cost)} تومانی ثبت شد.`,
    {
      inline_keyboard: [
        [btn("💎 مشاهده دارایی‌ها", "m:assets")],
        [btn("🏠 منوی اصلی", "m:home")],
      ],
    },
  );
}

async function ensureAssetPurchaseFunds(env, chatId, msg, state) {
  const a = state.asset;
  const balance = a.box
    ? await getBoxBalance(env, a.box.id)
    : a.account
      ? await getAccountBalance(env, a.account.id)
      : null;
  if (balance === null || a.cost <= balance) return true;

  const sourceName = a.box
    ? `باکس «${a.box.name}»`
    : `حساب «${a.account.name}»`;
  state.assetStep = "insufficient-funds";
  await setState(env, chatId, state);
  await panel(
    env,
    chatId,
    msg,
    `❌ موجودی ${sourceName} کافی نیست.\nمبلغ خرید: <b>${fmt(a.cost)} تومان</b>\nموجودی فعلی: <b>${fmt(balance)} تومان</b>\n\nحساب یا باکس را شارژ کن، یا مبلغ/منبع پرداخت را تغییر بده.`,
    {
      inline_keyboard: [
        [btn("✏️ تغییر مبلغ خرید", "x:assetcostedit")],
        [btn("🔄 تغییر منبع پرداخت", "x:assetsourceedit")],
        [btn("❌ لغو", "x:x")],
      ],
    },
  );
  return false;
}

async function startNewCategory(env, chatId, msg, group = null, parentId = null) {
  let parent = null;
  if (parentId) {
    parent = (await listCategories(env, true)).find((x) => idEq(x.id, parentId));
    if (!parent || parent.parentIds.length)
      return editPanel(env, msg, "❌ ساخت دسته‌ی سطح سوم مجاز نیست. برای افزودن زیر‌دسته، یک دسته‌ی کلی را انتخاب کن.", backHome());
  }
  const schema = await getSchema(env, "categories");
  const st = {
    flow: "new",
    ent: "c",
    pos: 0,
    props: {},
    labels: {},
    step: "value",
  };
  const orderField = schema.editable.find((p) => /ترتیب/.test(p.name));
  const categoryRows = orderField ? await queryDb(env, "categories") : [];
  const nextOrder = categoryRows.reduce(
    (max, page) => Math.max(max, propNumber(page, orderField?.name)),
    0,
  ) + 1;
  for (const p of schema.editable) {
    if (/ترتیب/.test(p.name)) {
      if (p.type === "number") st.props[p.name] = { number: nextOrder };
      else if (p.type === "select" && p.options?.[0])
        st.props[p.name] = selectProp(p.options[0]);
      else if (p.type === "status" && p.options?.[0])
        st.props[p.name] = { status: { name: p.options[0] } };
      else if (p.type === "rich_text") st.props[p.name] = richTextProp(String(nextOrder));
      if (st.props[p.name] !== undefined) st.labels[p.name] = String(nextOrder);
    }
    if (p.type === "checkbox" && p.name === CAT.active) {
      st.props[p.name] = { checkbox: true };
      st.labels[p.name] = "✅";
    }
    if (categoryHierarchyField(p.name) === "parent") {
      if (parentId) {
        if (p.type === "relation") st.props[p.name] = { relation: [{ id: parentId }] };
        else if (p.type === "select" && p.options?.includes(parent.name))
          st.props[p.name] = selectProp(parent.name);
        else if (p.type === "status" && p.options?.includes(parent.name))
          st.props[p.name] = { status: { name: parent.name } };
        else if (p.type === "multi_select" && p.options?.includes(parent.name))
          st.props[p.name] = { multi_select: [{ name: parent.name }] };
        else if (p.type === "checkbox") st.props[p.name] = { checkbox: true };
        else st.props[p.name] = emptyPayload(p);
        st.labels[p.name] = parent.name;
      } else {
        st.props[p.name] = p.type === "relation" ? { relation: [] } : emptyPayload(p);
        st.labels[p.name] = "—";
      }
    }
    if (categoryHierarchyField(p.name) === "level") {
      if (["select", "status"].includes(p.type)) {
        const options = p.options || [];
        const selected = parentId
          ? options.find((x) => /جزئی|فرعی|زیر|فرزند/.test(x)) || options.find((x) => x !== "کلی")
          : options.find((x) => /کلی|مادر|والد/.test(x));
        st.props[p.name] = selected
          ? p.type === "status" ? { status: { name: selected } } : selectProp(selected)
          : p.type === "status" ? { status: null } : { select: null };
        st.labels[p.name] = selected || "—";
      } else if (p.type === "number") {
        st.props[p.name] = { number: parentId ? 2 : 1 };
        st.labels[p.name] = parentId ? "۲" : "۱";
      } else if (p.type === "rich_text") {
        const value = parentId ? "زیر‌دسته" : "کلی";
        st.props[p.name] = richTextProp(value);
        st.labels[p.name] = value;
      } else if (p.type === "checkbox") {
        st.props[p.name] = { checkbox: !!parentId };
        st.labels[p.name] = parentId ? "✅" : "⬜";
      }
    }
    if (group && /گروه|نوع/.test(p.name) && ["select", "status"].includes(p.type)) {
      const selected = (p.options || []).find((x) => categoryGroupKind(x) === group);
      if (selected) {
        st.props[p.name] = p.type === "status" ? { status: { name: selected } } : selectProp(selected);
        st.labels[p.name] = selected;
      }
    }
  }
  return advanceNew(env, chatId, msg, st);
}

function categoryHierarchyField(name) {
  const normalized = String(name || "").replace(/[\u200c\s_-]/g, "").toLowerCase();
  if (normalized === CAT.parent.replace(/[\u200c\s_-]/g, "").toLowerCase() ||
      /دسته.{0,5}(?:مادر|والد)|(?:مادر|والد).{0,5}دسته/.test(normalized))
    return "parent";
  if (normalized === CAT.level.replace(/[\u200c\s_-]/g, "").toLowerCase() ||
      /سطح|زیر.*دسته/.test(normalized))
    return "level";
  return null;
}

function categoryFieldLabel(entity, property) {
  return entity === "c" && categoryHierarchyField(property.name) === "parent"
    ? "دسته‌ی کلی"
    : property.name;
}

async function startNew(env, chatId, msg, e) {
  if (e === "s") return startNewAsset(env, chatId, msg);
  const schema = await getSchema(env, ENT[e].key);
  const st = {
    flow: "new",
    ent: e,
    pos: 0,
    props: {},
    labels: {},
    step: "value",
  };
  for (const p of schema.editable) {
    if (p.type === "checkbox" && p.name === "فعال") {
      st.props[p.name] = { checkbox: true };
      st.labels[p.name] = "✅";
    }
  }
  if (e === "b") {
    const systemField = schema.props.find(
      (p) => p.name === BOX.system && p.type === "checkbox",
    );
    if (systemField) st.props[BOX.system] = { checkbox: false };
  }
  if (e === "a") {
    for (const p of schema.props) {
      if (!isAccountOpeningDateField(p)) continue;
      const createdOn = todayTehran();
      st.props[p.name] = { date: { start: createdOn } };
      st.labels[p.name] = createdOn;
    }
  }
  return advanceNew(env, chatId, msg, st);
}

async function advanceNew(env, chatId, msg, st) {
  const schema = await getSchema(env, ENT[st.ent].key);
  while (st.pos < schema.editable.length) {
    const p = schema.editable[st.pos];
    if (st.props[p.name] !== undefined) {
      st.pos += 1;
      continue;
    }
    return askField(env, chatId, msg, st, p, "new");
  }
  st.step = "confirm";
  await setState(env, chatId, st);
  const lines = [
    `${ENT[st.ent].icon} <b>تأیید ${esc(ENT[st.ent].one)} جدید</b>`,
    "",
  ];
  for (const p of schema.editable) {
    if (st.props[p.name] === undefined) continue;
    if (
      st.ent === "b" &&
      p.name !== BOX.title &&
      p.name !== BOX.active &&
      !(p.type === "rich_text" && /توضیح/.test(p.name))
    )
      continue;
    const money = isMoneyField(st.ent, p.name);
    const displayName =
      st.ent === "c" && categoryHierarchyField(p.name) === "parent"
        ? "دسته‌ی کلی"
        : st.ent === "a" && ["مانده اولیه", ACC.balance].includes(p.name)
        ? "موجودی حساب"
        : st.ent === "b" && p.name === BOX.title
          ? "نام باکس"
          : st.ent === "b" && p.type === "rich_text" && /توضیح/.test(p.name)
            ? "توضیحات"
            : st.ent === "b" && p.name === BOX.active
              ? "وضعیت"
              : p.name;
    const value =
      st.ent === "b" && p.name === BOX.active
        ? st.props[p.name]?.checkbox
          ? "✅ فعال"
          : "⛔ غیرفعال"
        : money
          ? fmt(st.props[p.name]?.number)
          : (st.labels[p.name] ?? "");
    lines.push(
      `${esc(displayName)}: <b>${esc(value)}</b>${money ? " تومان" : ""}`,
    );
  }
  return panel(env, chatId, msg, lines.join("\n"), {
    inline_keyboard: [[btn("✅ ذخیره", "x:w")], [btn("❌ لغو", "x:x")]],
  });
}

function parseFieldInput(e, p, text) {
  const t = text.trim();
  switch (p.type) {
    case "title":
      if (!t) return { error: "عنوان نمی‌تواند خالی باشد." };
      return { payload: titleProp(t), label: t };
    case "rich_text":
      return { payload: richTextProp(t), label: t };
    case "url":
      return { payload: { url: t }, label: t };
    case "email":
      return { payload: { email: t }, label: t };
    case "phone_number":
      return { payload: { phone_number: toEnDigits(t) }, label: t };
    case "number": {
      if (isMoneyField(e, p.name)) {
        const rial = parseAmountStrict(t);
        if (!Number.isFinite(rial) || rial < 0)
          return { error: "مبلغ نامعتبر است (تومان). مثال: 250000" };
        return { payload: { number: rial }, label: fmt(rial) };
      }
      const n = Number(toEnDigits(t).replace(/,/g, ""));
      if (!Number.isFinite(n)) return { error: "عدد نامعتبر است." };
      return { payload: { number: n }, label: fa(n) };
    }
    case "date": {
      const iso = parseDateInput(t);
      if (!iso)
        return {
          error: "تاریخ نامعتبر است. مثال: 1405/07/12 یا 2026-10-04 یا امروز",
        };
      return { payload: { date: { start: iso } }, label: jalaliStr(iso) };
    }
    default:
      return { error: "این نوع فیلد با تایپ پشتیبانی نمی‌شود." };
  }
}

function emptyPayload(p) {
  switch (p.type) {
    case "rich_text":
      return { rich_text: [] };
    case "number":
      return { number: null };
    case "select":
      return { select: null };
    case "status":
      return { status: null };
    case "multi_select":
      return { multi_select: [] };
    case "date":
      return { date: null };
    case "checkbox":
      return { checkbox: false };
    case "relation":
      return { relation: [] };
    case "url":
      return { url: null };
    case "email":
      return { email: null };
    case "phone_number":
      return { phone_number: null };
    default:
      return {};
  }
}

async function relOptions(env, p, search) {
  if (!p.relDb) return [];
  const schema = await getSchemaById(env, p.relDb);
  const filter =
    search && schema.titleName
      ? { property: schema.titleName, title: { contains: search } }
      : undefined;
  const rows = await queryDbById(env, p.relDb, { filter, limit: 40 });
  return rows
    .map((r) => ({ id: r.id, name: pageTitle(r) }))
    .filter((x) => x.name);
}

async function relationOptionsForField(env, st, p, search) {
  if (st.ent !== "c" || p.name !== CAT.parent) return relOptions(env, p, search);
  const roots = (await listCategories(env, true)).filter((x) => !x.parentIds.length);
  const query = String(search || "").trim();
  return roots
    .filter((x) => !query || x.name.includes(query))
    .map((x) => ({ id: x.id, name: x.name }));
}

const titleCache = new Map();
async function relNames(env, ids) {
  const uniq = [...new Set(ids.map(compactId))];
  await Promise.all(
    uniq
      .filter((id) => !titleCache.has(id))
      .map(async (id) => {
        try {
          const pg = await notion(env, "GET", `/pages/${id}`);
          titleCache.set(id, pageTitle(pg) || "—");
        } catch {
          titleCache.set(id, "؟");
        }
      }),
  );
  const m = new Map();
  for (const id of uniq) m.set(id, titleCache.get(id));
  return m;
}

/* ============================== Overview ============================== */

async function showMarketPrices(env, msg) {
  const chatId = msg.chat.id;
  try {
    if (!marketPriceCache.text || marketPriceCache.expiresAt <= Date.now()) {
      marketPriceCache.text = await loadMarketPrices();
      marketPriceCache.expiresAt = Date.now() + MARKET_PRICE_CACHE_MS;
    }
    return editPanel(env, msg, marketPriceCache.text, {
      inline_keyboard: [
        [btn("🔄 بروزرسانی قیمت‌ها", "m:assetpricesrefresh")],
        [
          btn("💎 بازگشت به دارایی‌ها", "m:assets"),
          btn("🏠 منوی اصلی", "m:home"),
        ],
      ],
    });
  } catch (error) {
    return editPanel(
      env,
      msg,
      `⚠️ دریافت قیمت‌ها از سرویس ناموفق بود.\n\n${esc(error.message)}\n\nلطفاً کمی بعد دوباره تلاش کن.`,
      {
        inline_keyboard: [
          [btn("🔄 تلاش دوباره", "m:assetpricesrefresh")],
          [
            btn("💎 بازگشت به دارایی‌ها", "m:assets"),
            btn("🏠 منوی اصلی", "m:home"),
          ],
        ],
      },
    );
  }
}

async function loadMarketPrices() {
  const items = [
    { key: "usd", label: "💵 دلار" },
    { key: "gbp", label: "💷 پوند" },
    { key: "euro", label: "💶 یورو" },
    { key: "gold-miskal", label: "⚜️ مثقال طلا" },
    { key: "coin-emami", label: "🟡 سکه امامی" },
    { key: "coin-baharazadi", label: "🟠 سکه بهار آزادی" },
    { key: "coin-baharazadi-nim", label: "🔸 نیم‌سکه" },
    { key: "coin-baharazadi-rob", label: "🔹 ربع‌سکه" },
    { key: "coin-gerami", label: "🟤 سکه گرمی" },
  ];
  const results = [];
  for (const item of items) {
    const response = await fetch(
      `https://api.priceto.day/v1/latest/irr/${encodeURIComponent(item.key)}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "ExpenseBot/1.0",
        },
      },
    );
    if (!response.ok) {
      const detail = (await response.text())
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      throw new Error(
        `سرویس قیمت با کد ${response.status} پاسخ داد.${detail ? ` جزئیات: ${detail}` : ""}`,
      );
    }
    const body = await response.json();
    if (body.success === false)
      throw new Error("سرویس قیمت دریافت نرخ را تأیید نکرد.");
    const price = marketPriceValue(body);
    if (!(price > 0))
      throw new Error(`قیمت «${item.key}» در پاسخ سرویس پیدا نشد.`);
    results.push({ ...item, price, updatedAt: marketPriceTimestamp(body) });
  }

  const byKey = new Map(results.map((item) => [item.key, item]));
  const miskal = byKey.get("gold-miskal").price;
  const gold18k = Math.round(miskal / GOLD_MISKAL_TO_18K_GRAM);
  const lines = [
    "📊 <b>نرخ لحظه‌ای ارز و طلا</b>",
    "",
    marketPriceLine(byKey.get("usd")),
    marketPriceLine(byKey.get("gbp")),
    marketPriceLine(byKey.get("euro")),
    "",
    "🪙 <b>طلا و سکه</b>",
    `🥇 طلای ۱۸ عیار: <b>${fmt(gold18k)} تومان</b>`,
    marketPriceLine(byKey.get("gold-miskal")),
    marketPriceLine(byKey.get("coin-emami")),
    marketPriceLine(byKey.get("coin-baharazadi")),
    marketPriceLine(byKey.get("coin-baharazadi-nim")),
    marketPriceLine(byKey.get("coin-baharazadi-rob")),
    marketPriceLine(byKey.get("coin-gerami")),
    "",
    `🕒 آخرین بروزرسانی: ${marketPricesUpdatedAt(results)}`,
    "📌 قیمت‌ها به تومان هستند.",
  ];
  return lines.join("\n");
}

function marketPriceLine(item) {
  return `${item.label}: <b>${fmt(item.price)} تومان</b>`;
}

function marketPriceValue(payload) {
  const candidates = [
    payload?.price,
    payload?.value,
    payload?.rate,
    payload?.result?.price,
    payload?.result?.value,
    payload?.result?.rate,
    payload?.data?.price,
    payload?.data?.value,
    payload?.data?.rate,
    payload?.data,
  ];
  for (const value of candidates) {
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return NaN;
}

function marketPriceTimestamp(payload) {
  const value =
    payload?.updated_at ??
    payload?.updatedAt ??
    payload?.timestamp ??
    payload?.result?.updated_at ??
    payload?.result?.updatedAt ??
    payload?.result?.timestamp ??
    payload?.data?.updated_at ??
    payload?.data?.updatedAt ??
    payload?.data?.timestamp;
  const timestamp = value == null ? NaN : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function marketPricesUpdatedAt(results) {
  const latest = Math.max(0, ...results.map((item) => item.updatedAt || 0));
  const parts = tehranParts(latest || Date.now());
  return `${jalaliStr(parts.date)} - ${fa(parts.time)}`;
}

async function showOverview(env, msg) {
  const cm = currentJMonth();
  const prev = cm.m === 1 ? { y: cm.y - 1, m: 12 } : { y: cm.y, m: cm.m - 1 };
  const [accounts, boxes, assets, thisMonth, lastMonth, categories] =
    await Promise.all([
      queryDb(env, "accounts"),
      queryDb(env, "boxes"),
      queryDb(env, "assets"),
      monthTransactions(env, cm.y, cm.m),
      monthTransactions(env, prev.y, prev.m),
      listCategories(env, true),
    ]);

  const sum = async (pages, name, activeName) => {
    const act = pages.filter((p) => propCheckbox(p, activeName) !== false);
    const nums = await Promise.all(act.map((p) => exactNumber(env, p, name)));
    return nums.reduce((a, b) => a + b, 0);
  };
  const [cash, boxTotal, assetValue] = await Promise.all([
    sum(accounts, ACC.balance, ACC.active),
    sum(boxes, BOX.balance, BOX.active),
    sum(assets, AST.value, AST.active),
  ]);

  const stat = (txs) => {
    const o = { income: 0, expense: 0, invested: 0 };
    for (const p of txs) {
      const t = propChoice(p, TX.type);
      const a = propNumber(p, TX.amount);
      if (t === "هزینه") o.expense += a;
      if (t === "درآمد") o.income += a;
      if (t === "خرید دارایی") o.invested += a;
    }
    return o;
  };
  const a = stat(thisMonth),
    b = stat(lastMonth);

  const categoryNames = new Map(
    categories.map((category) => [
      compactId(category.id),
      `${category.icon} ${category.name}`,
    ]),
  );
  const expensesByCategory = new Map();
  for (const tx of thisMonth) {
    if (propChoice(tx, TX.type) !== "هزینه") continue;
    const categoryId = tx.properties?.[TX.category]?.relation?.[0]?.id;
    const label = categoryId
      ? categoryNames.get(compactId(categoryId)) || "دسته‌ی حذف‌شده"
      : "بدون دسته‌بندی";
    expensesByCategory.set(
      label,
      (expensesByCategory.get(label) || 0) + propNumber(tx, TX.amount),
    );
  }
  const expenseRows = [...expensesByCategory.entries()]
    .map(([label, amount]) => ({ label, amount }))
    .sort((x, y) => y.amount - x.amount);
  const visibleExpenses = expenseRows.slice(0, 8);
  if (expenseRows.length > visibleExpenses.length) {
    visibleExpenses.push({
      label: "سایر دسته‌ها",
      amount: expenseRows
        .slice(8)
        .reduce((total, row) => total + row.amount, 0),
    });
  }
  const expenseCategoryLines = visibleExpenses.length
    ? visibleExpenses.map((row) => {
        const share = a.expense
          ? Math.round((row.amount / a.expense) * 100)
          : 0;
        return `▫️ ${esc(row.label)}: <b>${fmt(row.amount)} تومان</b> · ${fa(share)}٪`;
      })
    : ["در این ماه هزینه‌ای ثبت نشده است."];

  const text = [
    "📊 <b>داشبورد مالی</b>",
    "━━━━━━━━━━━━━━",
    "🏦 <b>وضعیت دارایی‌ها</b>",
    "",
    `💳 موجودی حساب‌ها: <b>${fmt(cash)} تومان</b>`,
    `📦 موجودی باکس‌ها: <b>${fmt(boxTotal)} تومان</b>`,
    `💎 ارزش دارایی‌ها: <b>${fmt(assetValue)} تومان</b>`,
    `🧮 مجموع حساب‌ها و دارایی‌ها: <b>${fmt(cash + assetValue)} تومان</b>`,
    "",
    "━━━━━━━━━━━━━━",
    `📅 <b>عملکرد ${MONTHS[cm.m - 1]} ${fa(cm.y)}</b>`,
    `📥 درآمد: <b>${fmt(a.income)} تومان</b>`,
    `📤 هزینه: <b>${fmt(a.expense)} تومان</b>`,
    `📈 خرید دارایی: <b>${fmt(a.invested)} تومان</b>`,
    `➕ خالص ماه: <b>${fmt(a.income - a.expense - a.invested)} تومان</b>`,
    "",
    "━━━━━━━━━━━━━━",
    "🏷 <b>هزینه‌های ماه بر اساس دسته‌بندی</b>",
    ...expenseCategoryLines,
    "",
    `↩️ ماه قبل (${MONTHS[prev.m - 1]} ${fa(prev.y)}): درآمد ${fmt(b.income)} · هزینه ${fmt(b.expense)} · خرید دارایی ${fmt(b.invested)} تومان`,
  ].join("\n");

  return editPanel(env, msg, text, {
    inline_keyboard: [
      [btn("📤 دریافت گزارش مالی", "m:csv")],
      [btn("🏠 منوی اصلی", "m:home")],
    ],
  });
}

function monthTransactions(env, y, m) {
  const r = jMonthRange(y, m);
  return queryDb(env, "transactions", {
    filter: {
      and: [
        { property: TX.status, select: { equals: "ثبت‌شده" } },
        { property: TX.date, date: { on_or_after: r.start } },
        { property: TX.date, date: { on_or_before: r.end } },
      ],
    },
    limit: 3000,
  });
}

/* ============================== CSV reports ============================== */

function reportTableMenu(env, chatId, msg) {
  const rows = [
    [btn("— 🧾 فعالیت‌های مالی —", "m:noop")],
    [btn("💳 تراکنش‌ها", "r:t:t"), btn("🎯 تخصیص‌ها", "r:t:l")],
    [btn("— 🏦 حساب‌ها و دارایی‌ها —", "m:noop")],
    [btn("🏦 حساب‌ها", "r:t:a"), btn("📦 باکس‌ها", "r:t:b")],
    [btn("💎 دارایی‌ها", "r:t:s"), btn("🏷 دسته‌بندی‌ها", "r:t:c")],
    [btn("🗂 گزارش همه‌ی بخش‌ها", "r:t:all")],
    [btn("🏠 منوی اصلی", "m:home")],
  ];
  return panel(
    env,
    chatId,
    msg,
    "📤 <b>گزارش‌ساز مالی</b>\n\n<b>۱. موضوع گزارش را انتخاب کن</b>\nبعد بازه، نوع گزارش و قالب فایل را مشخص می‌کنی.\n\n💰 مبلغ‌ها به تومان و تاریخ‌ها شمسی هستند.",
    { inline_keyboard: rows },
  );
}

async function handleReportCallback(env, msg, action, args) {
  const chatId = msg.chat.id;

  if (action === "t") {
    const e = args[0];
    if (e === "g")
      return editPanel(
        env,
        msg,
        "⏸ بخش اهداف مالی فعلاً غیرفعال است.",
        backHome(),
      );
    if (e !== "all" && !ENT[e]) return;
    const st = { flow: "report", ent: e, range: null, step: null };
    await setState(env, chatId, st);
    if (e === "all" || ENT[e].date) return rangeMenu(env, chatId, msg, st);
    st.mode = "detail";
    await setState(env, chatId, st);
    return reportFormatMenu(env, chatId, msg, st);
  }

  const st = await getState(env, chatId);
  if (!st || st.flow !== "report") {
    return editPanel(
      env,
      msg,
      "این عملیات منقضی شده. از منوی اصلی دوباره شروع کن.",
      backHome(),
    );
  }

  if (action === "g") {
    const k = args[0];
    const cm = currentJMonth();
    if (k === "pick") return monthPicker(env, msg);
    if (k === "custom") {
      st.step = "range";
      await setState(env, chatId, st);
      return send(
        env,
        chatId,
        "✍️ روز، ماه یا بازه را بفرست:\n<code>1405/07/12</code>\n<code>1405/07</code>\n<code>1405/07/01 تا 1405/07/15</code>",
        { reply_markup: { force_reply: true } },
      );
    }
    if (k === "all") st.range = null;
    else if (k === "today") {
      const d = todayTehran();
      st.range = { start: d, end: d };
    } else if (k === "thism") st.range = jMonthRange(cm.y, cm.m);
    else if (k === "lastm")
      st.range =
        cm.m === 1 ? jMonthRange(cm.y - 1, 12) : jMonthRange(cm.y, cm.m - 1);
    await setState(env, chatId, st);
    return afterRange(env, chatId, msg, st);
  }

  if (action === "m") {
    st.range = jMonthRange(Number(args[0]), Number(args[1]));
    await setState(env, chatId, st);
    return afterRange(env, chatId, msg, st);
  }

  if (action === "o") {
    st.mode = args[0];
    await setState(env, chatId, st);
    return reportFormatMenu(env, chatId, msg, st);
  }
  if (action === "f")
    return runReport(env, chatId, msg, st, st.mode || "detail", args[0]);
}

function rangeMenu(env, chatId, msg, st) {
  const note =
    st.ent === "all"
      ? "\n(بازه فقط روی جدول‌های تاریخ‌دار — تراکنش‌ها و تخصیص‌ها — اعمال می‌شود.)"
      : "";
  const title = st.ent === "all" ? "همه‌ی بخش‌ها" : ENT[st.ent].fa;
  return panel(
    env,
    chatId,
    msg,
    `📅 <b>۲. بازه‌ی گزارش</b>\n${esc(title)}${note}\n\nبازه را انتخاب کن:`,
    {
      inline_keyboard: [
        [btn("📅 امروز", "r:g:today"), btn("🗓 این ماه", "r:g:thism")],
        [btn("🗓 ماه قبل", "r:g:lastm"), btn("📆 انتخاب ماه", "r:g:pick")],
        [btn("✍️ روز / بازه‌ی دلخواه", "r:g:custom")],
        [btn("♾ همه‌ی زمان‌ها", "r:g:all")],
        [btn("🏠 منو", "m:home")],
      ],
    },
  );
}

function monthPicker(env, msg) {
  const cm = currentJMonth();
  const rows = [];
  let y = cm.y,
    m = cm.m;
  for (let i = 0; i < 12; i++) {
    rows.push(btn(`${MONTHS[m - 1]} ${fa(y)}`, `r:m:${y}:${m}`));
    if (--m === 0) {
      m = 12;
      y--;
    }
  }
  return editPanel(env, msg, "📆 ماه را انتخاب کن:", {
    inline_keyboard: [...chunk(rows, 3), [btn("🔙 بازگشت", "r:g:thism")]],
  });
}

async function afterRange(env, chatId, msg, st) {
  if (st.ent === "all") {
    st.mode = "detail";
    await setState(env, chatId, st);
    return reportFormatMenu(env, chatId, msg, st);
  }
  const groups = ENT[st.ent].groups || {};
  const rows = [[btn("📄 ریز کامل (همه‌ی ستون‌ها)", "r:o:detail")]];
  const gb = Object.entries(groups).map(([k, g]) =>
    btn(`${g.label}`, `r:o:${k}`),
  );
  if (gb.length) {
    rows.push([btn("— خلاصه به تفکیک —", "m:noop")]);
    rows.push(...chunk(gb, 2));
  }
  rows.push([btn("🏠 منو", "m:home")]);
  return panel(
    env,
    chatId,
    msg,
    `📤 <b>${esc(ENT[st.ent].fa)}</b>\n📅 بازه: ${rangeLabel(st.range)}\n\n<b>۳. نوع گزارش را انتخاب کن</b>`,
    { inline_keyboard: rows },
  );
}

function reportFormatMenu(env, chatId, msg, st) {
  const title = st.ent === "all" ? "همه‌ی بخش‌ها" : ENT[st.ent].fa;
  const step = st.ent === "all" ? "۳" : ENT[st.ent].date ? "۴" : "۲";
  return panel(
    env,
    chatId,
    msg,
    `📎 <b>${step}. قالب فایل</b>\n${esc(title)}\n📅 ${rangeLabel(st.range)}\n\nفایل موردنظرت را انتخاب کن:`,
    {
      inline_keyboard: [
        [btn("📊 فایل CSV", "r:f:csv"), btn("📄 فایل PDF", "r:f:pdf")],
        [btn("🔙 انتخاب گزارش", "m:csv"), btn("🏠 منو", "m:home")],
      ],
    },
  );
}

async function runReport(env, chatId, msg, st, mode, format = "csv") {
  await panel(env, chatId, msg, "⏳ در حال ساخت گزارش…");
  const list = st.ent === "all" ? ENT_ORDER : [st.ent];
  let sent = 0;
  let failed = 0;
  for (const e of list) {
    try {
      const r =
        mode === "detail"
          ? await buildDetail(env, e, st.range)
          : await buildSummary(env, e, st.range, mode);
      if (!r.count) continue;
      const label = ENT[e].date ? rangeLabel(st.range) : "همه";
      if (format === "pdf") {
        const pdf = await renderReportPdf(env, r, ENT[e], label, mode);
        const filename = r.filename.replace(/\.csv$/i, ".pdf");
        await sendDocument(
          env,
          chatId,
          filename,
          pdf,
          `${ENT[e].icon} ${ENT[e].fa} — ${label} — ${r.count} ردیف`,
          "application/pdf",
        );
      } else {
        await sendDocument(
          env,
          chatId,
          r.filename,
          r.csv,
          `${ENT[e].icon} ${ENT[e].fa} — ${label} — ${r.count} ردیف`,
          "text/csv",
        );
      }
      sent++;
    } catch (err) {
      failed++;
      await send(env, chatId, `⚠️ ${esc(ENT[e].fa)}: ${esc(err.message)}`);
    }
  }
  await clearState(env, chatId);
  if (!sent && failed) {
    return send(
      env,
      chatId,
      "⚠️ به‌دلیل خطا، گزارشی ساخته نشد. کمی بعد دوباره تلاش کن.",
      {
        reply_markup: {
          inline_keyboard: [
            [btn("📤 تلاش دوباره", "m:csv"), btn("🏠 منو", "m:home")],
          ],
        },
      },
    );
  }
  if (!sent) {
    const target =
      st.ent === "all"
        ? "در هیچ‌یک از بخش‌های انتخاب‌شده"
        : `در بخش «${ENT[st.ent].fa}»`;
    return send(
      env,
      chatId,
      `ℹ️ ${target} برای این بازه رکوردی پیدا نشد؛ گزارشی ساخته نشد.`,
      {
        reply_markup: {
          inline_keyboard: [
            [btn("📤 گزارش دیگر", "m:csv"), btn("🏠 منو", "m:home")],
          ],
        },
      },
    );
  }
  return send(env, chatId, `✅ ${fa(sent)} فایل ارسال شد.`, {
    reply_markup: {
      inline_keyboard: [
        [btn("📤 گزارش دیگر", "m:csv"), btn("🏠 منو", "m:home")],
      ],
    },
  });
}

async function fetchRows(env, e, range) {
  const ent = ENT[e];
  const filter =
    range && ent.date
      ? {
          and: [
            { property: ent.date, date: { on_or_after: range.start } },
            { property: ent.date, date: { on_or_before: range.end } },
          ],
        }
      : undefined;
  const sorts = ent.date
    ? [
        { property: ent.date, direction: "ascending" },
        { timestamp: "created_time", direction: "ascending" },
      ]
    : [{ timestamp: "created_time", direction: "ascending" }];
  return queryDb(env, ent.key, { filter, sorts, limit: MAX_EXPORT_ROWS });
}

async function relationMap(env, schema, pages) {
  const map = new Map();
  const dbs = new Set();
  for (const p of schema.props) {
    if (
      p.type === "relation" &&
      p.relDb &&
      pages.some((pg) => pg.properties?.[p.name]?.relation?.length)
    )
      dbs.add(p.relDb);
  }
  for (const id of dbs) {
    const rows = await queryDbById(env, id, { limit: 3000 });
    for (const r of rows) map.set(compactId(r.id), pageTitle(r));
  }
  return map;
}

function rangeTag(range) {
  if (!range) return "all";
  const a = jalaliStr(range.start, true).replace(/\//g, "-");
  const b = jalaliStr(range.end, true).replace(/\//g, "-");
  return a === b ? a : `${a}_${b}`;
}

async function buildDetail(env, e, range) {
  const ent = ENT[e];
  const schema = await getSchema(env, ent.key);
  const pages = await fetchRows(env, e, range);
  const rel = await relationMap(env, schema, pages);

  const cols = [
    ...schema.props.filter((p) => p.type === "title"),
    ...schema.props.filter(
      (p) => p.type !== "title" && p.type !== "files" && !isHiddenField(e, p),
    ),
  ];

  // برای جدول‌های کوچک، مقدارهای دقیق rollup/formula پولی را جدا می‌گیریم
  const exact = new Map();
  if (!ent.date) {
    const need = cols.filter(
      (p) =>
        isMoneyField(e, p.name) &&
        (p.type === "rollup" || p.type === "formula"),
    );
    const jobs = [];
    for (const pg of pages)
      for (const p of need) {
        if (!propNumber(pg, p.name)) jobs.push([pg, p]);
      }
    for (let i = 0; i < jobs.length; i += 5) {
      await Promise.all(
        jobs.slice(i, i + 5).map(async ([pg, p]) => {
          exact.set(`${pg.id}|${p.name}`, await exactNumber(env, pg, p.name));
        }),
      );
    }
  }

  const header = cols.map((p) =>
    isMoneyField(e, p.name) ? `${p.name} (تومان)` : p.name,
  );
  const lines = [csvLine(header)];
  for (const pg of pages) {
    lines.push(
      csvLine(
        cols.map((p) => {
          const money = isMoneyField(e, p.name);
          const key = `${pg.id}|${p.name}`;
          if (money && exact.has(key)) return tomanPlain(exact.get(key));
          return cellText(pg, p, { money, rel, csv: true });
        }),
      ),
    );
  }
  return {
    filename: `${ent.key}_detail_${rangeTag(ent.date ? range : null)}.csv`,
    csv: "\uFEFF" + lines.join("\r\n"),
    count: pages.length,
  };
}

async function buildSummary(env, e, range, mode) {
  const ent = ENT[e];
  const g = ent.groups[mode];
  if (!g) throw new Error("نوع گروه‌بندی نامعتبر");
  const schema = await getSchema(env, ent.key);
  const pages = await fetchRows(env, e, range);
  const rel = await relationMap(env, schema, pages);
  const amountName = e === "t" ? TX.amount : ALC.amount;

  const groups = new Map();
  let used = 0;
  for (const p of pages) {
    if (e === "t") {
      const st = propChoice(p, TX.status);
      if (st && st !== "ثبت‌شده") continue;
    }
    const dt = propDate(p, ent.date) || p.created_time.slice(0, 10);
    let sort, label;
    if (mode === "day") {
      sort = dt;
      label = jalaliStr(dt, true);
    } else if (mode === "month") {
      const [y, m] = isoToJalali(dt);
      sort = `${y}-${pad(m)}`;
      label = `${y}/${pad(m)} ${MONTHS[m - 1]}`;
    } else {
      const ids = (p.properties?.[g.rel]?.relation || []).map((r) => r.id);
      label = ids.length
        ? ids.map((id) => rel.get(compactId(id)) || "؟").join("، ")
        : "بدون مقدار";
      sort = label;
    }
    const row = groups.get(sort) || { sort, label, count: 0, sums: {} };
    row.count++;
    const amount = propNumber(p, amountName);
    const bucket = e === "t" ? propChoice(p, TX.type) || "؟" : "total";
    row.sums[bucket] = (row.sums[bucket] || 0) + amount;
    groups.set(sort, row);
    used++;
  }

  const rows = [...groups.values()];
  const byTime = mode === "day" || mode === "month";
  const lines = [];

  if (e === "t") {
    const net = (s) =>
      (s["درآمد"] || 0) +
      (s["فروش دارایی"] || 0) -
      (s["هزینه"] || 0) -
      (s["خرید دارایی"] || 0);
    const totalExpense = rows.reduce((a, r) => a + (r.sums["هزینه"] || 0), 0);
    if (byTime) rows.sort((a, b) => a.sort.localeCompare(b.sort));
    else rows.sort((a, b) => (b.sums["هزینه"] || 0) - (a.sums["هزینه"] || 0));

    const header = [
      "گروه",
      "تعداد",
      ...TX_TYPES.map((t) => `${t} (تومان)`),
      "خالص (تومان)",
    ];
    if (!byTime) header.push("سهم از هزینه ٪");
    lines.push(csvLine(header));
    const tot = { label: "جمع کل", count: 0, sums: {} };
    for (const r of rows) {
      tot.count += r.count;
      for (const t of TX_TYPES)
        tot.sums[t] = (tot.sums[t] || 0) + (r.sums[t] || 0);
    }
    for (const r of [...rows, tot]) {
      const line = [
        r.label,
        r.count,
        ...TX_TYPES.map((t) => tomanPlain(r.sums[t] || 0)),
        tomanPlain(net(r.sums)),
      ];
      if (!byTime)
        line.push(
          totalExpense
            ? (((r.sums["هزینه"] || 0) / totalExpense) * 100).toFixed(1)
            : "0",
        );
      lines.push(csvLine(line));
    }
  } else {
    if (byTime) rows.sort((a, b) => a.sort.localeCompare(b.sort));
    else rows.sort((a, b) => (b.sums.total || 0) - (a.sums.total || 0));
    lines.push(csvLine(["گروه", "تعداد", "مجموع مبلغ (تومان)"]));
    let c = 0,
      s = 0;
    for (const r of rows) {
      c += r.count;
      s += r.sums.total || 0;
      lines.push(csvLine([r.label, r.count, tomanPlain(r.sums.total || 0)]));
    }
    lines.push(csvLine(["جمع کل", c, tomanPlain(s)]));
  }
  return {
    filename: `${ent.key}_by-${mode}_${rangeTag(range)}.csv`,
    csv: "\uFEFF" + lines.join("\r\n"),
    count: used,
  };
}

const csvEsc = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (arr) => arr.map(csvEsc).join(",");

function parseCsvRows(csv) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  const text = String(csv).replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

const htmlEsc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const PDF_DETAIL_COLUMNS = {
  transactions: [
    TX.title,
    TX.type,
    TX.amount,
    TX.date,
    TX.fromAccount,
    TX.toAccount,
    TX.category,
    TX.box,
    TX.asset,
    TX.assetQty,
    TX.unitPrice,
    TX.desc,
  ],
  allocations: [
    ALC.title,
    ALC.amount,
    ALC.date,
    ALC.fromAccount,
    ALC.toAccount,
    ALC.fromBox,
    ALC.toBox,
    ALC.desc,
  ],
  accounts: [ACC.title, ACC.balance, ACC.type],
  boxes: [BOX.title, BOX.balance],
  categories: [CAT.title, CAT.level, CAT.parent],
  assets: [
    AST.title,
    AST.type,
    AST.symbol,
    AST.unit,
    AST.qty,
    AST.price,
    AST.value,
  ],
};

function preparePdfReport(report, ent, mode) {
  const rows = parseCsvRows(report.csv);
  const header = rows.shift() || [];
  const allowed = new Set(PDF_DETAIL_COLUMNS[ent.key] || []);
  const kept = header
    .map((name, index) => ({
      name: name.trim(),
      index,
      canonicalName: name
        .trim()
        .replace(/\s*\(تومان\)\s*$/, "")
        .trim(),
    }))
    .filter(
      ({ canonicalName }) => mode !== "detail" || allowed.has(canonicalName),
    );
  if (!kept.length) return report;
  const outputRows = [
    kept.map(({ name }) => name),
    ...rows.map((row) =>
      kept.map(({ index, name }) => {
        let value = row[index] ?? "";
        if (ent.key === "allocations" && name.trim() === ALC.title)
          value = value.replace(/→/g, "↔");
        return /\(تومان\)\s*$/.test(name) ? formatPdfToman(value) : value;
      }),
    ),
  ];
  return {
    ...report,
    csv: "\uFEFF" + outputRows.map(csvLine).join("\r\n"),
    count: rows.length,
  };
}

function formatPdfToman(value) {
  const number = Number(toEnDigits(String(value)).replace(/[٬,]/g, "").trim());
  if (!Number.isFinite(number)) return value;
  const normalized = Number.isInteger(number)
    ? String(number)
    : String(Number(number.toFixed(1)));
  return fa(grp(normalized));
}

function reportHtml(report, ent, label, fonts = null) {
  const rows = parseCsvRows(report.csv);
  const head = rows.shift() || [];
  const th = head.map((x) => `<th>${htmlEsc(x)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((x) => `<td>${htmlEsc(x)}</td>`).join("")}</tr>`)
    .join("");
  const fontFaces = fonts
    ? `@font-face{font-family:ShabnamFD;src:url('${fonts.regular}') format('woff2');font-style:normal;font-weight:400} @font-face{font-family:ShabnamFD;src:url('${fonts.bold}') format('woff2');font-style:normal;font-weight:700}`
    : "";
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><style>
    ${fontFaces}
    @page{size:A4 landscape;margin:14mm}*{box-sizing:border-box}body{font-family:ShabnamFD,Tahoma,Arial,sans-serif;color:#172033;margin:0;direction:rtl;font-size:11px}
    .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;padding:0 0 12px;border-bottom:2px solid #dbe6f1}.title{font-size:22px;font-weight:700;color:#163b65}.meta{font-size:11px;color:#64748b;background:#f1f5f9;border-radius:8px;padding:6px 10px}
    table{width:100%;border-collapse:collapse;font-size:10px;direction:rtl}thead{display:table-header-group}th{background:#163b65;color:#fff;font-weight:700}th,td{border:1px solid #d9e2ec;padding:7px;text-align:right;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}tr:nth-child(even) td{background:#f4f7fb}tr{break-inside:avoid}
    .foot{margin-top:12px;padding-top:8px;border-top:1px solid #d9e2ec;font-size:9px;color:#64748b;display:flex;justify-content:space-between}
  </style></head><body><div class="head"><div class="title">${htmlEsc(ent.icon)} گزارش ${htmlEsc(ent.fa)}</div><div class="meta">بازه: ${htmlEsc(label)}</div></div>
  <table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table><div class="foot"><span>${htmlEsc(fa(report.count))} ردیف · مبالغ به تومان</span><span>قلم Shabnam FD · Saber Rastikerdar · SIL OFL 1.1</span></div></body></html>`;
}

let shabnamFdFontsPromise;
async function shabnamFdFonts() {
  if (!shabnamFdFontsPromise) {
    const toDataUrl = async (filename) => {
      const response = await fetch(
        `https://unpkg.com/shabnam-font@5.0.0/dist/Farsi-Digits/${filename}`,
      );
      if (!response.ok) throw new Error(`دریافت قلم ${filename} ناموفق بود`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return `data:font/woff2;base64,${btoa(binary)}`;
    };
    shabnamFdFontsPromise = Promise.all([
      toDataUrl("Shabnam-FD.woff2"),
      toDataUrl("Shabnam-Bold-FD.woff2"),
    ])
      .then(([regular, bold]) => ({ regular, bold }))
      .catch((error) => {
        shabnamFdFontsPromise = null;
        throw error;
      });
  }
  return shabnamFdFontsPromise;
}

async function renderReportPdf(env, report, ent, label, mode = "detail") {
  const fonts = await shabnamFdFonts().catch(() => null);
  const pdfReport = preparePdfReport(report, ent, mode);
  const html = reportHtml(pdfReport, ent, label, fonts);
  const options = {
    html,
    pdfOptions: {
      format: "a4",
      landscape: true,
      printBackground: true,
      margin: { top: "14mm", right: "10mm", bottom: "14mm", left: "10mm" },
    },
  };
  if (env.BROWSER?.quickAction) {
    const result = await env.BROWSER.quickAction("pdf", options);
    return result instanceof Response ? result.arrayBuffer() : result;
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error("خروجی PDF هنوز در تنظیمات ورکر فعال نشده است");
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/pdf`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `ساخت PDF ناموفق بود: ${data.errors?.[0]?.message || res.status}`,
    );
  }
  return res.arrayBuffer();
}

/* ============================== Notion property helpers ============================== */

function propPlain(p) {
  if (!p) return null;
  switch (p.type) {
    case "title":
      return (p.title || []).map((x) => x.plain_text).join("");
    case "rich_text":
      return (p.rich_text || []).map((x) => x.plain_text).join("");
    case "number":
      return p.number;
    case "string":
      return p.string;
    case "boolean":
      return p.boolean;
    case "select":
      return p.select?.name ?? null;
    case "status":
      return p.status?.name ?? null;
    case "multi_select":
      return (p.multi_select || []).map((x) => x.name).join("، ");
    case "date":
      return p.date ? { start: p.date.start, end: p.date.end } : null;
    case "checkbox":
      return p.checkbox;
    case "url":
      return p.url;
    case "email":
      return p.email;
    case "phone_number":
      return p.phone_number;
    case "relation":
      return (p.relation || []).map((x) => x.id);
    case "created_time":
      return { start: p.created_time };
    case "last_edited_time":
      return { start: p.last_edited_time };
    case "people":
      return (p.people || []).map((x) => x.name).join("، ");
    case "unique_id":
      return `${p.unique_id?.prefix ? p.unique_id.prefix + "-" : ""}${p.unique_id?.number ?? ""}`;
    case "formula":
      return propPlain({
        type: p.formula?.type,
        [p.formula?.type]: p.formula?.[p.formula?.type],
      });
    case "rollup": {
      const r = p.rollup;
      if (!r) return null;
      if (r.type === "array")
        return (r.array || [])
          .map(propPlain)
          .filter((v) => v != null && typeof v !== "object")
          .join("، ");
      return propPlain({ type: r.type, [r.type]: r[r.type] });
    }
    default:
      return null;
  }
}

function cellText(page, p, o = {}) {
  const v = propPlain(page.properties?.[p.name]);
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return "";
  const csv = !!o.csv;
  if (p.type === "relation") {
    return v.map((id) => o.rel?.get(compactId(id)) || "؟").join("، ");
  }
  if (typeof v === "number") {
    if (o.money) return csv ? tomanPlain(v) : fmt(v);
    return csv ? String(v) : fa(trimNum(v));
  }
  if (typeof v === "boolean")
    return csv ? (v ? "بله" : "خیر") : v ? "✅" : "⬜";
  if (typeof v === "object" && v.start) return fmtDateVal(v, csv);
  return String(v);
}

function fmtDateVal(dv, latin) {
  const one = (s) => {
    if (!s) return "";
    const parts = s.length > 10 ? tehranParts(s) : { date: s, time: "" };
    const time =
      parts.time && parts.time !== "00:00"
        ? ` ${latin ? parts.time : fa(parts.time)}`
        : "";
    return jalaliStr(parts.date, latin) + time;
  };
  return dv.end ? `${one(dv.start)} تا ${one(dv.end)}` : one(dv.start);
}

function pageTitle(page) {
  for (const p of Object.values(page.properties || {})) {
    if (p.type === "title")
      return (p.title || [])
        .map((x) => x.plain_text)
        .join("")
        .trim();
  }
  return "";
}

function pageEmoji(page, fallback = "🏷") {
  return page?.icon?.type === "emoji" && page.icon.emoji
    ? page.icon.emoji
    : fallback;
}

const propTitle = (page, name) =>
  (page.properties?.[name]?.title || [])
    .map((x) => x.plain_text)
    .join("")
    .trim();
const propText = (page, name) =>
  (page.properties?.[name]?.rich_text || [])
    .map((x) => x.plain_text)
    .join("")
    .trim();
const propChoice = (page, name) => {
  const p = page.properties?.[name];
  return (
    p?.select?.name ?? p?.status?.name ?? p?.multi_select?.[0]?.name ?? null
  );
};
const propDate = (page, name) =>
  page.properties?.[name]?.date?.start?.slice(0, 10) || null;
const propCheckbox = (page, name) => {
  const p = page.properties?.[name];
  return p?.type === "checkbox" ? p.checkbox : null;
};

function propNumber(page, name) {
  const p = page.properties?.[name];
  if (!p) return 0;
  return numberFromItem(p) ?? 0;
}

function numberFromItem(x) {
  if (!x) return null;
  if (x.type === "number") return x.number;
  if (x.type === "formula" && x.formula?.type === "number")
    return x.formula.number;
  if (x.type === "rollup" && x.rollup?.type === "number")
    return x.rollup.number;
  return null;
}

// برای formula/rollup ممکن است مقدار صفحه‌ی query ناقص باشد؛ در این حالت از endpoint دقیق می‌خوانیم.
async function exactNumber(env, page, name) {
  const p = page.properties?.[name];
  const direct = propNumber(page, name);
  if (
    direct ||
    !p?.id ||
    !["rollup", "formula"].includes(p.type) ||
    env.EXACT_ROLLUPS === "0"
  )
    return direct;
  try {
    const r = await notion(
      env,
      "GET",
      `/pages/${page.id}/properties/${encodeURIComponent(p.id)}`,
    );
    if (r.object === "list") {
      for (const x of r.results || []) {
        const n = numberFromItem(x);
        if (n !== null && n !== undefined) return n;
      }
      return direct;
    }
    return numberFromItem(r) ?? direct;
  } catch {
    return direct;
  }
}

const titleProp = (s) => ({
  title: [{ text: { content: String(s).slice(0, 2000) } }],
});
const richTextProp = (s) => ({
  rich_text: [{ text: { content: String(s).slice(0, 2000) } }],
});
const selectProp = (name) => ({ select: { name } });
const relationProp = (id) => ({ relation: [{ id }] });

function isHiddenField(e, p) {
  const name = String(p.name || "").trim();
  const normalizedName = name.replace(/[\s_-]/g, "").toLowerCase();
  if (p.type === "unique_id") return true;
  if (/^(?:app|application)?id$/.test(normalizedName)) return true;
  if (e === "b" && [BOX.system, BOX.incoming, BOX.outgoing].includes(name))
    return true;
  if (e === "b" && /کد|ترتیب/.test(name)) return true;
  if (e === "b" && (p.type === "relation" || /ورودی|خروجی/.test(name)))
    return true;
  if (e === "c" && p.type === "relation" && categoryHierarchyField(name) !== "parent")
    return true;
  if ([TX.currency, TX.chartGroup, ACC.currency, AST.currency].includes(name))
    return true;
  if (/^(?:id|شناسه|شناسه‌ی|شناسه ی)(?:\s|$)/i.test(name)) return true;
  if (/(?:database|table|notion)\s*id/i.test(name)) return true;
  if (/ریال/.test(name)) return true;
  if (e === "a" && isAccountOpeningDateField(p)) return true;
  if (e === "a" && p.type === "relation") return true;
  return false;
}

function isMoneyField(e, name) {
  return ENT[e].money.includes(name) || (e === "a" && name === "مانده اولیه");
}

function isHiddenAccountDetailField(e, p) {
  if (e !== "a") return false;
  return p.name === "مانده اولیه";
}

function isAccountOpeningDateField(p) {
  const name = String(p.name || "").trim();
  return (
    p.type === "date" &&
    /(?:تاریخ.*(?:مانده|موجودی)|(?:مانده|موجودی).*تاریخ)/.test(name)
  );
}

/* ============================== Notion API ============================== */

function dbId(env, key) {
  const envName = DB[key];
  const raw = String(env[envName] || "")
    .split("?")[0]
    .replace(/-/g, "");
  const m = raw.match(/[0-9a-f]{32}/i);
  if (!m) throw new Error(`${envName} معتبر نیست`);
  return m[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notion(env, method, path, body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && i < tries - 1) {
      await sleep((Number(res.headers.get("Retry-After")) || 1) * 1000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        `Notion ${res.status}: ${data.message || "unknown error"}`,
      );
    return data;
  }
}

async function queryDbById(env, id, { filter, sorts, limit = 1000 } = {}) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: Math.min(100, limit - out.length) };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    const res = await notion(
      env,
      "POST",
      `/databases/${compactId(id)}/query`,
      body,
    );
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && out.length < limit);
  return out;
}

const queryDb = (env, key, opts) => queryDbById(env, dbId(env, key), opts);

const schemaCache = new Map();
async function getSchemaById(env, id) {
  const cid = compactId(id);
  const c = schemaCache.get(cid);
  if (c && c.exp > Date.now()) return c.v;
  const db = await notion(env, "GET", `/databases/${cid}`);
  const props = Object.entries(db.properties).map(([name, p]) => ({
    name,
    id: p.id,
    type: p.type,
    options:
      (p.select || p.status || p.multi_select)?.options?.map((o) => o.name) ||
      null,
    relDb: p.relation?.database_id || null,
  }));
  const titleName = props.find((p) => p.type === "title")?.name;
  const editable = [
    ...props.filter((p) => p.type === "title"),
    ...props.filter((p) => p.type !== "title" && EDITABLE.has(p.type)),
  ];
  const v = { props, editable, titleName };
  schemaCache.set(cid, { v, exp: Date.now() + 10 * 60 * 1000 });
  return v;
}
async function getSchema(env, key) {
  const schema = await getSchemaById(env, dbId(env, key));
  const e = Object.keys(ENT).find((k) => ENT[k].key === key);
  if (!e) return schema;
  return {
    ...schema,
    editable: schema.editable.filter((p) => !isHiddenField(e, p)),
  };
}

async function namedRows(env, key, titleField, pred = () => true) {
  const rows = await queryDb(env, key);
  return rows
    .filter(pred)
    .map((p) => ({ id: p.id, name: propTitle(p, titleField) }))
    .filter((x) => x.name);
}
const listAccounts = (env) =>
  namedRows(
    env,
    "accounts",
    ACC.title,
    (p) => propCheckbox(p, ACC.active) !== false,
  );

async function getAccountBalance(env, id) {
  const accounts = await queryDb(env, "accounts");
  const page = accounts.find((x) => idEq(x.id, id));
  return page ? exactNumber(env, page, ACC.balance) : 0;
}

async function findMainAccount(env) {
  const rows = (await queryDb(env, "accounts")).filter(
    (p) => propCheckbox(p, ACC.active) !== false,
  );
  const accounts = rows.map((p) => ({
    id: p.id,
    name: propTitle(p, ACC.title),
    type: propChoice(p, ACC.type),
  }));
  return (
    accounts.find((x) => x.name.trim() === "حساب اصلی") ||
    accounts.find((x) => x.name.trim() === "اصلی") ||
    accounts.find((x) => /اصلی/.test(x.type || "")) ||
    accounts.find((x) => /حساب\s*اصلی/.test(x.name || "")) ||
    null
  );
}

const allocationSchemaReady = new Map();
async function ensureAllocationAccountSchema(env) {
  const allocationDbId = dbId(env, "allocations");
  const accountDbId = dbId(env, "accounts");
  const cachedUntil = allocationSchemaReady.get(allocationDbId);
  if (cachedUntil && cachedUntil > Date.now()) return;

  const database = await notion(env, "GET", `/databases/${allocationDbId}`);
  const missing = {};
  for (const name of [ALC.fromAccount, ALC.toAccount]) {
    const property = database.properties?.[name];
    if (!property) {
      missing[name] = {
        relation: { database_id: accountDbId, single_property: {} },
      };
    } else if (
      property.type !== "relation" ||
      !idEq(property.relation?.database_id, accountDbId)
    ) {
      throw new Error(
        `ستون «${name}» باید رابطه‌ای به پایگاه‌داده حساب‌ها باشد`,
      );
    }
  }
  if (Object.keys(missing).length) {
    await notion(env, "PATCH", `/databases/${allocationDbId}`, {
      properties: missing,
    });
    schemaCache.delete(allocationDbId);
  }
  allocationSchemaReady.set(allocationDbId, Date.now() + 10 * 60 * 1000);
}

const listBoxes = (env) =>
  namedRows(
    env,
    "boxes",
    BOX.title,
    (p) => propCheckbox(p, BOX.active) !== false,
  );
const listAssets = (env) =>
  namedRows(
    env,
    "assets",
    AST.title,
    (p) => propCheckbox(p, AST.active) !== false,
  );

async function listCategories(env, includeInactive = false) {
  const rows = await queryDb(env, "categories");
  return rows
    .filter((p) => includeInactive || propCheckbox(p, CAT.active) !== false)
    .map((p) => {
      const name = propTitle(p, CAT.title);
      const group = categoryGroup(p);
      const parentIds = (p.properties?.[CAT.parent]?.relation || []).map((r) => r.id);
      return {
        id: p.id,
        name,
        icon: categoryDisplayIcon(p),
        level: propChoice(p, CAT.level),
        group,
        active: propCheckbox(p, CAT.active) !== false,
        parentIds,
      };
    })
    .filter((x) => x.name);
}

async function categoryDescendants(env, categoryId) {
  const categories = await listCategories(env, true);
  const descendants = [];
  let parents = [categoryId];
  while (parents.length) {
    const children = categories.filter((category) =>
      !idEq(category.id, categoryId) &&
      !descendants.some((found) => idEq(found.id, category.id)) &&
      category.parentIds.some((parentId) =>
        parents.some((id) => idEq(id, parentId)),
      ),
    );
    if (!children.length) break;
    descendants.push(...children);
    parents = children.map((category) => category.id);
  }
  return descendants.reverse();
}

function categoryDisplayIcon(page) {
  return page?.icon?.type === "emoji" && page.icon.emoji
    ? page.icon.emoji
    : "";
}

function categoryGroup(page) {
  for (const [name, property] of Object.entries(page.properties || {})) {
    const value =
      property.select?.name ||
      property.status?.name ||
      property.multi_select?.map((x) => x.name).join(" ") ||
      property.rich_text?.map((x) => x.plain_text).join("") ||
      property.title?.map((x) => x.plain_text).join("") ||
      "";
    if (value && (/گروه|نوع/.test(name) || categoryGroupKind(value))) return value;
  }
  return "";
}

function categoryGroupKind(value) {
  const normalized = String(value || "").replace(/[\u200c\s_-]/g, "");
  if (/هزینه|خرج/.test(normalized)) return "expense";
  if (/سرمایهگذاری/.test(normalized)) return "investment";
  if (/درآمد/.test(normalized)) return "income";
  return null;
}

async function transactionCategories(env, state) {
  const all = await listCategories(env);
  if (state?.flow !== "tx" || state.draft?.type !== "درآمد") return all;

  const roots = all.filter((x) => x.level === "کلی");
  const rootRows = roots.length ? roots : all.filter((x) => !x.parentIds.length);
  const allowed = new Set();
  for (const root of rootRows) {
    const children = all.filter((x) =>
      x.parentIds.some((id) => idEq(id, root.id)),
    );
    const rootKind = categoryGroupKind(root.group) || categoryGroupKind(root.name);
    const childKinds = children.map(
      (x) => categoryGroupKind(x.group) || rootKind || categoryGroupKind(root.name),
    );
    const rootAllowed = ["income", "investment"].includes(rootKind) ||
      childKinds.some((kind) => ["income", "investment"].includes(kind));
    if (!rootAllowed) continue;
    allowed.add(compactId(root.id));
    children.forEach((child, i) => {
      if (["income", "investment"].includes(childKinds[i]))
        allowed.add(compactId(child.id));
    });
  }
  return all.filter((x) => allowed.has(compactId(x.id)));
}

async function getUnallocatedBox(env) {
  const rows = await queryDb(env, "boxes");
  const p = rows.find(
    (x) =>
      propText(x, BOX.code) === "unallocated" ||
      propTitle(x, BOX.title) === "تعیین‌تکلیف‌نشده",
  );
  return p ? { id: p.id, name: propTitle(p, BOX.title) } : null;
}

async function getBoxBalance(env, id) {
  const boxes = await queryDb(env, "boxes");
  const page = boxes.find((x) => idEq(x.id, id));
  return page ? exactNumber(env, page, BOX.balance) : 0;
}

async function checkConnections(env) {
  const lines = ["⚙️ <b>بررسی اتصال Notion</b>", ""];
  for (const key of Object.keys(DB)) {
    try {
      const db = await notion(env, "GET", `/databases/${dbId(env, key)}`);
      lines.push(
        `✅ ${faLabel(key)} — ${esc((db.title || []).map((t) => t.plain_text).join("") || key)}`,
      );
    } catch (e) {
      lines.push(`❌ ${faLabel(key)} — ${esc(e.message)}`);
    }
  }
  lines.push(
    "",
    env.DB ? "✅ D1 (حافظه‌ی مکالمه)" : "❌ D1 binding با نام DB تنظیم نشده",
  );
  lines.push(
    env.BROWSER || (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
      ? "✅ سرویس خروجی PDF"
      : "⚠️ سرویس خروجی PDF تنظیم نشده",
  );
  return lines.join("\n");
}

function faLabel(k) {
  return (
    {
      transactions: "تراکنش‌ها",
      accounts: "حساب‌ها",
      categories: "دسته‌بندی‌ها",
      boxes: "باکس‌ها",
      allocations: "تخصیص منابع",
      assets: "دارایی‌ها",
      goals: "اهداف مالی",
    }[k] || k
  );
}

function assertEnv(env) {
  if (!env.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN تنظیم نشده");
  if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN تنظیم نشده");
}

/* ============================== Telegram API ============================== */

async function tg(env, method, body) {
  const base = env.BOT_API_BASE || "https://api.telegram.org";
  const res = await fetch(`${base}/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (
    !data.ok &&
    !String(data.description).includes("message is not modified")
  ) {
    throw new Error(`Telegram ${method}: ${data.description}`);
  }
  return data.result;
}

async function send(env, chatId, text, extra = {}) {
  const result = await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
  await rememberMessage(env, chatId, result).catch(() => {});
  if (extra.reply_markup?.inline_keyboard?.length)
    await rememberActiveMenu(env, chatId, result.message_id, true).catch(
      () => {},
    );
  return result;
}

async function editPanel(env, msg, text, keyboard) {
  const result = await tg(env, "editMessageText", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
  await rememberActiveMenu(
    env,
    msg.chat.id,
    result.message_id || msg.message_id,
    !!keyboard?.inline_keyboard?.length,
  ).catch(() => {});
  return result;
}

// اگر پیام دکمه‌ای داریم ویرایشش می‌کنیم، وگرنه پیام جدید می‌فرستیم
const panel = (env, chatId, msg, text, kb) =>
  msg
    ? editPanel(env, msg, text, kb)
    : send(env, chatId, text, kb ? { reply_markup: kb } : {});

async function sendDocument(
  env,
  chatId,
  filename,
  content,
  caption,
  contentType = "application/octet-stream",
) {
  const base = env.BOT_API_BASE || "https://api.telegram.org";
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  fd.append("document", new Blob([content], { type: contentType }), filename);
  const res = await fetch(`${base}/bot${env.TELEGRAM_TOKEN}/sendDocument`, {
    method: "POST",
    body: fd,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendDocument: ${data.description}`);
  await rememberMessage(env, chatId, data.result).catch(() => {});
  return data.result;
}

const btn = (text, callback_data) => ({ text, callback_data });

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ============================== State (D1) ============================== */

let tableReady = false;
async function ensureStateDb(env) {
  if (!env.DB)
    throw new Error(
      "برای جریان‌های چندمرحله‌ای، D1 binding با نام DB لازم است",
    );
  if (!tableReady) {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)",
    ).run();
    tableReady = true;
  }
}

async function setState(env, chatId, value) {
  await ensureStateDb(env);
  await env.DB.prepare(
    "INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp",
  )
    .bind(`state:${chatId}`, JSON.stringify(value), Date.now() + STATE_TTL_MS)
    .run();
  if (Math.random() < 0.05)
    await env.DB.prepare("DELETE FROM kv WHERE exp < ?").bind(Date.now()).run();
}

async function getState(env, chatId) {
  await ensureStateDb(env);
  const row = await env.DB.prepare("SELECT v,exp FROM kv WHERE k=?")
    .bind(`state:${chatId}`)
    .first();
  if (!row || row.exp < Date.now()) return null;
  return JSON.parse(row.v);
}

async function clearState(env, chatId) {
  if (!env.DB) return;
  await ensureStateDb(env);
  await env.DB.prepare("DELETE FROM kv WHERE k=?")
    .bind(`state:${chatId}`)
    .run();
}

async function claimCallbackAction(env, cq) {
  await ensureStateDb(env);
  const now = Date.now();
  const key = `callback:${cq.message.chat.id}:${cq.message.message_id}:${cq.data}`;
  const result = await env.DB.prepare(
    "INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,exp=excluded.exp WHERE kv.exp < ?",
  )
    .bind(key, "1", now + 4_000, now)
    .run();
  const changes = result.meta?.changes;
  return typeof changes !== "number" || changes === 1;
}

async function rememberMessage(env, chatId, msg) {
  if (!env.DB || !msg?.message_id) return;
  await ensureStateDb(env);
  const key = `ui:${chatId}`;
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k=?")
    .bind(key)
    .first();
  let ids = [];
  try {
    ids = JSON.parse(row?.v || "[]");
  } catch {
    ids = [];
  }
  ids = [...new Set([...ids, Number(msg.message_id)])].slice(-UI_MESSAGE_LIMIT);
  await env.DB.prepare(
    "INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp",
  )
    .bind(key, JSON.stringify(ids), Date.now() + 7 * 24 * 60 * 60 * 1000)
    .run();
}

async function getActiveMenuState(env, chatId) {
  if (!env.DB) return { initialized: false, ids: [] };
  await ensureStateDb(env);
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k=?")
    .bind(`ui:menus:${chatId}`)
    .first();
  if (!row) return { initialized: false, ids: [] };
  try {
    return {
      initialized: true,
      ids: JSON.parse(row.v).map(Number).filter(Number.isFinite),
    };
  } catch {
    return { initialized: true, ids: [] };
  }
}

async function rememberActiveMenu(env, chatId, messageId, active) {
  if (!env.DB || !messageId) return;
  await ensureStateDb(env);
  const key = `ui:menus:${chatId}`;
  const state = await getActiveMenuState(env, chatId);
  const ids = state.ids.filter((id) => id !== Number(messageId));
  if (active) ids.push(Number(messageId));
  await env.DB.prepare(
    "INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,exp=excluded.exp",
  )
    .bind(key, JSON.stringify(ids.slice(-12)), Date.now() + 7 * 24 * 60 * 60 * 1000)
    .run();
}

async function clearActiveMenus(
  env,
  chatId,
  knownState = null,
  { deleteMenus = false, keepId = null } = {},
) {
  if (!env.DB) return;
  await ensureStateDb(env);
  const state = knownState || (await getActiveMenuState(env, chatId));
  let ids = state.ids;
  if (!state.initialized) {
    const row = await env.DB.prepare("SELECT v FROM kv WHERE k=?")
      .bind(`ui:${chatId}`)
      .first();
    try {
      ids = JSON.parse(row?.v || "[]").map(Number).filter(Number.isFinite);
    } catch {
      ids = [];
    }
  }
  await Promise.all(
    ids.map((messageId) =>
      Number(messageId) === Number(keepId)
        ? tg(env, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
          }).catch(() => {})
        : deleteMenus && state.initialized
          ? tg(env, "deleteMessage", {
              chat_id: chatId,
              message_id: messageId,
            }).catch(() =>
              tg(env, "editMessageReplyMarkup", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: [] },
              }).catch(() => {}),
            )
          : tg(env, "editMessageReplyMarkup", {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: { inline_keyboard: [] },
            }).catch(() => {}),
    ),
  );
  await env.DB.prepare(
    "INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,exp=excluded.exp",
  )
    .bind(`ui:menus:${chatId}`, "[]", Date.now() + 7 * 24 * 60 * 60 * 1000)
    .run();
}

async function cleanupMessages(env, chatId, keepId = null) {
  if (!env.DB) return;
  await ensureStateDb(env);
  const key = `ui:${chatId}`;
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k=?")
    .bind(key)
    .first();
  let ids = [];
  try {
    ids = JSON.parse(row?.v || "[]");
  } catch {
    ids = [];
  }
  for (const id of ids) {
    if (Number(id) === Number(keepId)) continue;
    await tg(env, "deleteMessage", { chat_id: chatId, message_id: id }).catch(
      () => {},
    );
  }
  const kept = keepId ? [Number(keepId)] : [];
  await env.DB.prepare(
    "INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp",
  )
    .bind(key, JSON.stringify(kept), Date.now() + 7 * 24 * 60 * 60 * 1000)
    .run();
  await env.DB.prepare("DELETE FROM kv WHERE k=?")
    .bind(`ui:menus:${chatId}`)
    .run();
}

/* ============================== Amount parsing (Toman → Rial) ============================== */

const NUMBER_WORDS = {
  صفر: 0,
  یک: 1,
  يه: 1,
  یه: 1,
  دو: 2,
  سه: 3,
  چهار: 4,
  پنج: 5,
  شش: 6,
  شیش: 6,
  هفت: 7,
  هشت: 8,
  نه: 9,
  ده: 10,
  یازده: 11,
  دوازده: 12,
  سیزده: 13,
  چهارده: 14,
  پانزده: 15,
  شانزده: 16,
  هفده: 17,
  هجده: 18,
  نوزده: 19,
  بیست: 20,
  سی: 30,
  چهل: 40,
  پنجاه: 50,
  شصت: 60,
  هفتاد: 70,
  هشتاد: 80,
  نود: 90,
  صد: 100,
  یکصد: 100,
  دویست: 200,
  سیصد: 300,
  چهارصد: 400,
  پانصد: 500,
  ششصد: 600,
  هفتصد: 700,
  هشتصد: 800,
  نهصد: 900,
};
const AMOUNT_SCALES = {
  هزار: 1e3,
  میلیون: 1e6,
  میلیارد: 1e9,
  k: 1e3,
  m: 1e6,
  b: 1e9,
};

function normalizeAmountText(text) {
  return toEnDigits(text)
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/تومن/g, "تومان")
    .replace(/،/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function wordsToNumber(text) {
  const clean = text.trim();
  if (!clean) return NaN;
  if (clean === "نیم") return 0.5;
  if (clean.endsWith(" و نیم")) {
    const whole = wordsToNumber(clean.slice(0, -6));
    return Number.isFinite(whole) ? whole + 0.5 : NaN;
  }

  let total = 0,
    current = 0,
    found = false;
  for (const token of clean.split(/\s+و\s+|\s+/).filter(Boolean)) {
    if (NUMBER_WORDS[token] !== undefined) {
      current += NUMBER_WORDS[token];
      found = true;
    } else if (AMOUNT_SCALES[token]) {
      current = (current || 1) * AMOUNT_SCALES[token];
      total += current;
      current = 0;
      found = true;
    } else {
      return NaN;
    }
  }
  return found ? total + current : NaN;
}

function parseNumberPart(text) {
  const clean = text.trim().replace(/,/g, "");
  if (/^\d+(?:\.\d+)?$/.test(clean)) return Number(clean);
  return wordsToNumber(clean);
}

// ورودی کاربر تومان است؛ خروجی همیشه ریال و آماده‌ی ذخیره در Notion است.
function parseAmountStrict(text) {
  let clean = normalizeAmountText(text);
  if (!clean) return NaN;
  const isRial = /ریال/.test(clean);
  clean = clean
    .replace(/تومان|ریال/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const compound = clean.match(
    /^(.+?)\s*(میلیارد|میلیون|هزار|k|m|b)(?:\s+و\s+(.+))?$/i,
  );
  let toman;
  if (compound) {
    const first = parseNumberPart(compound[1]);
    const scale = AMOUNT_SCALES[compound[2].toLowerCase()];
    if (!Number.isFinite(first) || !scale) return NaN;
    toman = first * scale;
    if (compound[3]) {
      const tailText = compound[3].trim();
      const explicitTail = /(میلیارد|میلیون|هزار|k|m|b)$/i.test(tailText);
      let tail = explicitTail
        ? parseAmountToman(tailText)
        : parseNumberPart(tailText);
      if (!Number.isFinite(tail)) return NaN;
      if (!explicitTail && tail < 1000 && scale >= 1e6) tail *= scale / 1000;
      toman += tail;
    }
  } else {
    toman = parseNumberPart(clean);
  }
  if (!Number.isFinite(toman)) return NaN;
  return Math.round(isRial ? toman : toman * RIAL_PER_TOMAN);
}

function parseAmountToman(text) {
  const rial = parseAmountStrict(text);
  return Number.isFinite(rial) ? rial / RIAL_PER_TOMAN : NaN;
}

function parseAmountOnly(text) {
  const v = parseAmountStrict(text);
  return Number.isFinite(v) ? v : 0;
}

function toEnDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
}

/* ============================== Formatting ============================== */

const fa = (s) => String(s ?? 0).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const grp = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// ریال → تومان (نمایش، ارقام فارسی)
const fmt = (rial) => fa(grp(Math.round((Number(rial) || 0) / RIAL_PER_TOMAN)));
// ریال → تومان (CSV، ارقام لاتین بدون جداکننده)
const tomanPlain = (rial) => {
  const t = (Number(rial) || 0) / RIAL_PER_TOMAN;
  return String(Number.isInteger(t) ? t : Number(t.toFixed(1)));
};
const trimNum = (n) => String(Number(Number(n).toFixed(8)));
const pad = (n) => String(n).padStart(2, "0");
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function progressBar(p) {
  const filled = Math.round(Math.max(0, Math.min(100, p)) / 10);
  return "🟩".repeat(filled) + "⬜️".repeat(10 - filled);
}

const compactId = (id) => String(id).replace(/-/g, "");
const idEq = (a, b) => compactId(a) === compactId(b);

/* ============================== Dates (Jalali) ============================== */

const MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];

function todayTehran() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function tehranParts(ts) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const o = Object.fromEntries(
    f.formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${o.year}-${o.month}-${o.day}`,
    time: `${o.hour}:${o.minute}`,
  };
}

const isoToJalali = (iso) => gregorianToJalali(...iso.split("-").map(Number));

function jalaliStr(iso, latin = false) {
  const [y, m, d] = isoToJalali(iso);
  const s = `${y}/${pad(m)}/${pad(d)}`;
  return latin ? s : fa(s);
}

const gIso = (g) => `${g[0]}-${pad(g[1])}-${pad(g[2])}`;

function jMonthRange(jy, jm) {
  const start = jalaliToGregorian(jy, jm, 1);
  const [ny, nm] = jm === 12 ? [jy + 1, 1] : [jy, jm + 1];
  const next = jalaliToGregorian(ny, nm, 1);
  return { start: gIso(start), end: addDays(gIso(next), -1) };
}

function currentJMonth() {
  const [y, m] = isoToJalali(todayTehran());
  return { y, m };
}

function parseDateInput(text) {
  const t = toEnDigits(text).trim();
  if (/^(امروز|today)$/i.test(t)) return todayTehran();
  if (/^(دیروز|yesterday)$/i.test(t)) return addDays(todayTehran(), -1);
  const m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y < 1700) {
    if (mo > 6 && d > 30) return null;
    return gIso(jalaliToGregorian(y, mo, d));
  }
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function expandToken(tok) {
  const mm = tok.match(/^(\d{4})[\/\-.](\d{1,2})$/);
  if (mm) {
    const y = Number(mm[1]),
      m = Number(mm[2]);
    if (m < 1 || m > 12) return null;
    if (y < 1700) return jMonthRange(y, m);
    const start = `${y}-${pad(m)}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
    return { start, end: addDays(next, -1) };
  }
  const d = parseDateInput(tok);
  return d ? { start: d, end: d } : null;
}

function parseRangeInput(text) {
  const t = toEnDigits(text).trim();
  const parts = t.split(/\s+(?:تا|to|-)\s+|\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const a = expandToken(parts[0]);
  const b = parts.length === 2 ? expandToken(parts[1]) : a;
  if (!a || !b || a.start > b.end) return null;
  return { start: a.start, end: b.end };
}

function rangeLabel(range) {
  if (!range) return "همه‌ی زمان‌ها";
  return range.start === range.end
    ? jalaliStr(range.start)
    : `${jalaliStr(range.start)} تا ${jalaliStr(range.end)}`;
}

function gregorianToJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    355666 +
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) +
    gd +
    gdm[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm =
    days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

function jalaliToGregorian(jy, jm, jd) {
  jy += 1595;
  let days =
    -355668 +
    365 * jy +
    Math.floor(jy / 33) * 8 +
    Math.floor(((jy % 33) + 3) / 4) +
    jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const sal = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 13 && gd > sal[gm]) {
    gd -= sal[gm];
    gm++;
  }
  return [gy, gm, gd];
}
