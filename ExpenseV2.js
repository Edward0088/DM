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
  balance: "مانده",
  active: "فعال",
  system: "سیستمی",
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
  if (cmd === "/check") return send(env, chatId, await checkConnections(env));
  if (cmd === "/csv") {
    await clearState(env, chatId);
    return reportTableMenu(env, chatId, null);
  }

  const state = await getState(env, chatId);
  if (!state) return sendMainMenu(env, chatId, "از منوی زیر انتخاب کن 👇");

  // ---- ثبت تراکنش ----
  if (state.flow === "tx" && state.step === "title") {
    if (!text || text.length > 200) {
      return send(env, chatId, "❌ عنوان باید بین ۱ تا ۲۰۰ نویسه باشد.");
    }
    state.draft.title = text;
    state.draft.date = todayTehran();
    state.step = "amount-choice";
    await setState(env, chatId, state);
    return askTxAmount(env, chatId, state);
  }

  if (state.flow === "tx" && state.step === "amount-input") {
    const amount = parseScaledAmount(text, state.moneyUnitFactor);
    if (!(amount > 0))
      return send(env, chatId, scaledAmountError(state.moneyUnitFactor));
    state.pendingAmount = amount;
    state.step = "amount-review";
    await setState(env, chatId, state);
    return sendAmountReview(env, chatId, amount, "tx:amount-ok", "tx:amount-edit");
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
    return sendAmountReview(env, chatId, amount, "al:amount-ok", "al:amount-edit");
  }
  if (state.flow === "allocation" && state.step === "percent-input") {
    const percent = parsePercentInput(text);
    if (!(percent > 0 && percent <= 100))
      return send(env, chatId, "❌ درصد را از ۱ تا ۱۰۰ وارد کن؛ مثلاً <code>۲۵</code>.");
    const amount = Math.round((state.maxAmount * percent) / 100);
    if (!(amount > 0))
      return send(env, chatId, "❌ این درصد از موجودی مبلغ قابل تخصیصی ایجاد نمی‌کند.");
    state.pendingAmount = amount;
    state.selectedPercent = percent;
    state.step = "amount-review";
    await setState(env, chatId, state);
    return sendAmountReview(env, chatId, amount, "al:amount-ok", "al:amount-edit");
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
    "برای ادامه از دکمه‌های همان پیام استفاده کن، یا /cancel را بزن.",
  );
}

/* ============================== Callbacks ============================== */

async function handleCallback(cq, env) {
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  const msg = cq.message;
  if (!msg) return;
  if (!(await claimCallbackAction(env, cq))) return;
  const [ns, action, ...args] = String(cq.data || "").split(":");

  if (ns === "m" && action === "noop") return;
  if (ns === "m") return handleMenu(env, msg, action);
  if (ns === "tx") return handleTxCallback(env, msg, action, args);
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

  if (action === "transactions")
    return editPanel(
      env,
      msg,
      "💳 <b>تراکنش‌ها</b>\nیکی از گزینه‌ها را انتخاب کن:",
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
    return editPanel(env, msg, "⏸ بخش اهداف مالی فعلاً غیرفعال است.", backHome());

  if (action === "home") {
    await cleanupMessages(env, chatId, msg.message_id);
    return editPanel(env, msg, mainMenuText(), mainMenuKeyboard());
  }
  if (action === "new") {
    return editPanel(
      env,
      msg,
      "➕ <b>ثبت تراکنش جدید</b>\nنوع تراکنش را انتخاب کن:",
      txTypeKeyboard(),
    );
  }
  if (action === "help")
    return editPanel(env, msg, helpText(), backHome());
  if (action === "report") return showOverview(env, msg);
  if (action === "csv") return reportTableMenu(env, chatId, msg);
  if (action === "check")
    return editPanel(env, msg, await checkConnections(env), backHome());
}

function mainMenuText(extra = "") {
  return (
    `${extra ? esc(extra) + "\n\n" : ""}💳 <b>پلتفرم مدیریت مالی</b>\n\n` +
    `<b>همه‌چیز درباره پولت، یکجا.</b>\n\n` +
    `سلام 👋\n` +
    `من دستیار مالی تو هستم؛ برای ثبت، مدیریت و تحلیل جریان پول و دارایی‌هات.`
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
      [btn("💳 تراکنش", "m:transactions"), btn("🎯 تخصیص منابع", "m:allocations")],
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
      [btn("📈 خرید دارایی", "tx:type:خرید دارایی"), btn("📉 فروش دارایی", "tx:type:فروش دارایی")],
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
  return `❌ فقط عدد را وارد کن؛ مثلاً <code>${factor === 1_000_000 ? "۳۲" : "۵۰۰"}</code>.`;
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
      input_field_placeholder: factor === 1_000_000 ? "مثلاً ۳۲ یا ۱٫۵" : "مثلاً ۵۰۰ یا ۱٫۵",
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
    `💰 <b>مبلغ شما:</b>\n\n<b>${fmt(amount)} تومان</b>`,
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
      `${TYPE_META[type].icon} <b>${esc(type)} انتخاب شد.</b>`,
      { inline_keyboard: [[btn("❌ لغو", "tx:cancel")]] },
    );
    return send(
      env,
      chatId,
      `📝 عنوان ${esc(type)} را وارد کن.`,
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "مثلاً خرید روزانه",
        },
      },
    );
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
    await editPanel(
      env,
      msg,
      amountReplyNotice(),
      { inline_keyboard: [[btn("❌ لغو", "tx:cancel")]] },
    );
    return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
  }

  if (action === "amount-edit") {
    state.step = "amount-input";
    await setState(env, chatId, state);
    await editPanel(
      env,
      msg,
      amountReplyNotice(),
      { inline_keyboard: [[btn("❌ لغو", "tx:cancel")]] },
    );
    return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
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
    );
  }

  if (action === "subpg") {
    return chooseCategoryChild(
      env,
      chatId,
      msg,
      args[0],
      Number(args[1]) || 0,
      args[2] === "1",
    );
  }

  if (action === "catroot") {
    const x = (await listCategories(env)).find((c) => idEq(c.id, args[0]));
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
    );
  }

  if (action === "catmain" || action === "cat") {
    const x = (await listCategories(env)).find((c) => idEq(c.id, args[0]));
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
    await saveTransaction(env, state.draft);
    await clearState(env, chatId);
    return editPanel(
      env,
      msg,
      `✅ <b>تراکنش با موفقیت ثبت شد</b>\n💵 مبلغ: <b>${fmt(state.draft.amount)} تومان</b>`,
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
  const rows = [
    [btn("۵۰ هزار", "tx:amount:50000"), btn("۱۰۰ هزار", "tx:amount:100000")],
    [btn("۲۵۰ هزار", "tx:amount:250000"), btn("۵۰۰ هزار", "tx:amount:500000")],
    [
      btn("۱ میلیون", "tx:amount:1000000"),
      btn("۲ میلیون", "tx:amount:2000000"),
    ],
    [btn("✍️ مبلغ دلخواه", "tx:custom")],
    [btn("❌ لغو", "tx:cancel")],
  ];
  return send(
    env,
    chatId,
    `💵 <b>مبلغ «${esc(state.draft.title)}»</b>\nیک مبلغ پیشنهادی را بزن یا مبلغ دلخواه را وارد کن.`,
    { reply_markup: { inline_keyboard: rows } },
  );
}

async function continueTxFlow(env, chatId, state, msg = null) {
  const d = state.draft;
  const meta = TYPE_META[d.type];

  if (meta.accountMode === "from" && !d.fromAccount)
    return choose(env, chatId, msg, "acc", { role: "from" });
  if (meta.accountMode === "to" && !d.toAccount)
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

  if (meta.needsBox && !d.box) return choose(env, chatId, msg, "box");
  if (meta.optionalBox && !d.box && !d.skipBox)
    return choose(env, chatId, msg, "box", { optional: true });

  if (d.type === "درآمد" && !d.box) {
    const ub = await getUnallocatedBox(env);
    if (ub) d.box = ub;
  }

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
          ? "🏦 حساب مقصد را انتخاب کن:"
          : "🏦 حساب مبدأ را انتخاب کن:",
      cb: (id) => `tx:acc:${role}:${id}`,
    },
    box: {
      list: async () => await listBoxes(env),
      icon: "📦",
      text: "📦 باکس مربوط به این تراکنش را انتخاب کن:",
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
) {
  const all = await listCategories(env);
  const explicitRoots = all.filter((x) => x.level === "کلی");
  const roots = explicitRoots.length
    ? explicitRoots
    : all.filter((x) => !x.parentIds.length);
  const pages = Math.max(1, Math.ceil(roots.length / PICK_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = roots.slice(page * PICK_SIZE, (page + 1) * PICK_SIZE);
  const rows = chunk(
    slice.map((x) =>
      btn(
        `${x.icon} ${x.name}`,
        `tx:catroot:${compactId(x.id)}:${optional ? "1" : "0"}`,
      ),
    ),
    2,
  );

  if (pages > 1) {
    const nav = [];
    if (page > 0)
      nav.push(btn("◀️ قبلی", `tx:catpg:${page - 1}:${optional ? "1" : "0"}`));
    nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
    if (page < pages - 1)
      nav.push(btn("بعدی ▶️", `tx:catpg:${page + 1}:${optional ? "1" : "0"}`));
    rows.push(nav);
  }
  if (optional) rows.push([btn("⏭ بدون دسته‌بندی", "tx:skip:cat")]);
  rows.push([btn("❌ لغو", "tx:cancel")]);
  const text = roots.length
    ? "🏷 <b>دسته‌بندی کلی</b>\nابتدا دسته‌ی اصلی تراکنش را انتخاب کن:"
    : "⚠️ دسته‌بندی کلی فعالی پیدا نشد.";
  return panel(env, chatId, msg, text, { inline_keyboard: rows });
}

async function chooseCategoryChild(
  env,
  chatId,
  msg,
  rootId,
  page = 0,
  optional = false,
) {
  const all = await listCategories(env);
  const root = all.find((x) => idEq(x.id, rootId));
  if (!root) return chooseCategoryRoot(env, chatId, msg, 0, optional);
  const children = all.filter((x) =>
    x.parentIds.some((id) => idEq(id, root.id)),
  );
  if (!children.length) {
    const state = await getState(env, chatId);
    if (!state || state.flow !== "tx") return;
    state.draft.category = root;
    delete state.draft.categoryRoot;
    await setState(env, chatId, state);
    return continueTxFlow(env, chatId, state, msg);
  }

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
          `tx:subpg:${compactId(root.id)}:${page - 1}:${optional ? "1" : "0"}`,
        ),
      );
    nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
    if (page < pages - 1)
      nav.push(
        btn(
          "بعدی ▶️",
          `tx:subpg:${compactId(root.id)}:${page + 1}:${optional ? "1" : "0"}`,
        ),
      );
    rows.push(nav);
  }
  if (optional) rows.push([btn("⏭ بدون دسته‌بندی", "tx:skip:cat")]);
  rows.push([btn("🔙 دسته‌های کلی", `tx:catpg:0:${optional ? "1" : "0"}`)]);
  rows.push([btn("❌ لغو", "tx:cancel")]);
  return panel(
    env,
    chatId,
    msg,
    `${esc(root.icon)} <b>${esc(root.name)}</b>\nیک زیر‌دسته را انتخاب کن؛ یا تراکنش را با همین دسته‌ی کلی ثبت کن:`,
    { inline_keyboard: rows },
  );
}

async function sendTxConfirm(env, chatId, state, msg = null) {
  const d = state.draft;
  const lines = [
    `${TYPE_META[d.type].icon} <b>تأیید تراکنش</b>`,
    "",
    `نوع: ${esc(d.type)}`,
    `عنوان: ${esc(d.title)}`,
    `مبلغ: <b>${fmt(d.amount)} تومان</b>`,
    d.fromAccount ? `از حساب: ${esc(d.fromAccount.name)}` : null,
    d.toAccount ? `به حساب: ${esc(d.toAccount.name)}` : null,
    d.box ? `باکس: ${esc(d.box.name)}` : null,
    d.category
      ? `دسته‌بندی: ${esc(d.category.icon || "🏷")} ${esc(d.category.name)}`
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
  const props = {
    [TX.title]: titleProp(d.title),
    [TX.type]: selectProp(d.type),
    [TX.amount]: { number: d.amount },
    [TX.currency]: selectProp(d.currency || DEFAULT_CURRENCY),
    [TX.date]: { date: { start: d.date } },
    [TX.status]: selectProp("ثبت‌شده"),
  };
  if (d.fromAccount) props[TX.fromAccount] = relationProp(d.fromAccount.id);
  if (d.toAccount) props[TX.toAccount] = relationProp(d.toAccount.id);
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
  return editPanel(env, msg, "🎯 <b>انتقال بین حساب و باکس</b>\nجهت انتقال را انتخاب کن:", {
    inline_keyboard: [
      [btn("🏦 حساب به باکس", "al:assign")],
      [btn("📦 باکس به حساب", "al:release")],
      [btn("🏠 منوی اصلی", "m:home")],
    ],
  });
}

async function handleAllocationCallback(env, msg, action, args) {
  const chatId = msg.chat.id;
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
    await editPanel(
      env,
      msg,
      amountReplyNotice(),
      { inline_keyboard: [[btn("❌ لغو", "al:cancel")]] },
    );
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
    await editPanel(
      env,
      msg,
      amountReplyNotice(),
      { inline_keyboard: [[btn("❌ لغو", "al:cancel")]] },
    );
    return sendScaledAmountPrompt(env, chatId, state.moneyUnitFactor);
  }

  if (action === "amount-ok" && state.step === "amount-review") {
    state.draft.amount = state.pendingAmount;
    delete state.pendingAmount;
    state.step = "confirm";
    await setState(env, chatId, state);
    return sendAllocationConfirm(env, chatId, state, msg);
  }

  if (action === "from" && state.step === "from-box" && state.draft.operation === "release") {
    const source = (await listBoxes(env)).find((x) => idEq(x.id, args[0]));
    if (!source) return;
    state.draft.fromBox = source;
    state.maxAmount = await getBoxBalance(env, source.id);
    if (!(state.maxAmount > 0))
      return editPanel(env, msg, `📦 «${esc(source.name)}» موجودی قابل انتقال ندارد.`, backHome());
    state.step = "to-account";
    await setState(env, chatId, state);
    return allocationChooseAccount(env, msg, "to-account");
  }

  if (action === "account" && ["from-account", "to-account"].includes(state.step)) {
    const account = (await listAccounts(env)).find((x) => idEq(x.id, args[0]));
    if (!account) return;
    if (state.step === "from-account") {
      state.draft.fromAccount = account;
      state.maxAmount = await getAccountBalance(env, account.id);
      if (!(state.maxAmount > 0))
        return editPanel(env, msg, `🏦 «${esc(account.name)}» موجودی قابل انتقال ندارد.`, backHome());
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

  if (action === "to" && state.step === "to-box" && state.draft.operation === "assign") {
    const target = (await listBoxes(env)).find(
      (x) =>
        idEq(x.id, args[0]),
    );
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
    const complete = d.operation === "assign"
      ? d.fromAccount && d.toBox
      : d.fromBox && d.toAccount;
    if (state.step !== "confirm" || !complete)
      return editPanel(env, msg, "جزئیات تخصیص کامل نیست. عملیات را دوباره شروع کن.", backHome());
    const available = d.operation === "assign"
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
        [btn("📋 سوابق تخصیص‌ها", "m:allocationhistory"), btn("🏠 منو", "m:home")],
      ],
    });
  }
}

async function allocationChooseBox(env, msg, role, exclude, available = null) {
  const rows = (await listBoxes(env))
    .filter((x) => !exclude || !idEq(x.id, exclude))
    .map((x) => btn(`📦 ${x.name}`, `al:${role}:${compactId(x.id)}`));
  if (!rows.length)
    return editPanel(env, msg, "📦 برای این عملیات باکس دیگری در دسترس نیست.", backHome());
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
    return editPanel(env, msg, "🏦 حساب فعالی برای انتقال پیدا نشد.", backHome());
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
  const fromLabel = d.operation === "assign" ? d.fromAccount.name : d.fromBox.name;
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
  const fromName = d.operation === "assign" ? d.fromAccount.name : d.fromBox.name;
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
    if (d.operation === "assign") txProps[TX.fromAccount] = relationProp(d.fromAccount.id);
    else txProps[TX.toAccount] = relationProp(d.toAccount.id);
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
    return editPanel(env, msg, "⏸ بخش اهداف مالی فعلاً غیرفعال است.", backHome());
  }

  if (action === "ca") {
    await clearState(env, chatId);
    return showCategoryRoot(env, chatId, msg, args[0]);
  }
  if (action === "cs") {
    await clearState(env, chatId);
    return listCategoryChildren(env, chatId, msg, args[0], Number(args[1]) || 0);
  }
  if (action === "cp") {
    await clearState(env, chatId);
    const parentId = args[0] === "-" ? null : args[0];
    const page = Number(args[1]) || 0;
    return parentId
      ? listCategoryChildren(env, chatId, msg, parentId, page)
      : listCategoryRoots(env, chatId, msg, page);
  }

  if (["l", "v", "e", "d", "D", "n", "x"].includes(action))
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

  if (action === "n") {
    const e = args[0];
    if (e === "t")
      return editPanel(
        env,
        msg,
        "➕ <b>ثبت تراکنش جدید</b>\nنوع تراکنش را انتخاب کن:",
        txTypeKeyboard(),
      );
    if (e === "l") return startAllocation(env, msg);
    return startNew(env, chatId, msg, e);
  }

  if (action === "e") {
    const [e, id] = args;
    const schema = await getSchema(env, ENT[e].key);
    const rows = schema.editable.map((p, i) => [
      btn(`✏️ ${p.name}`, `x:f:${e}:${id}:${i}`),
    ]);
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
    return editPanel(
      env,
      msg,
      "🗑 مطمئنی این رکورد حذف شود؟\n(در Notion به سطل زباله می‌رود و تا ۳۰ روز قابل بازیابی است.)",
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
    await notion(env, "PATCH", `/pages/${id}`, { archived: true });
    return editPanel(env, msg, "✅ رکورد حذف شد.", {
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
  const schema = await getSchema(env, ENT[st.ent].key);
  const p = schema.props.find((x) => x.name === st.propName);

  if (action === "unit" && p && isMoneyField(st.ent, p.name)) {
    st.moneyUnitFactor = amountUnitFactor(args[0]);
    if (!st.moneyUnitFactor) return;
    st.step = "money-input";
    await setState(env, chatId, st);
    await editPanel(
      env,
      msg,
      amountReplyNotice(),
      {
        inline_keyboard: [
          [
            btn(
              "❌ لغو",
              st.flow === "new" ? "x:x" : `x:v:${st.ent}:${st.pageId}`,
            ),
          ],
        ],
      },
    );
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
    return setFieldValue(
      env,
      chatId,
      msg,
      st,
      { number: amount },
      fmt(amount),
    );
  }
  if (st.ent === "g") {
    await clearState(env, chatId);
    return editPanel(env, msg, "⏸ بخش اهداف مالی فعلاً غیرفعال است.", backHome());
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
      const name = propTitle(p, ent.title) || "بدون عنوان";
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
  kb.push([btn(`➕ ${ent.one} جدید`, `x:n:${e}`), btn("📤 CSV", `r:t:${e}`)]);
  if (e === "s")
    kb.push([
      btn("📈 خرید دارایی", "tx:type:خرید دارایی"),
      btn("📉 فروش دارایی", "tx:type:فروش دارایی"),
    ]);
  kb.push([btn("🏠 منوی اصلی", "m:home")]);

  const text =
    `${ent.icon} <b>${esc(ent.fa)}</b> — صفحه ${fa(page + 1)}\n` +
    (slice.length
      ? "برای مشاهده، ویرایش یا حذف روی یک مورد بزن 👇"
      : "موردی ثبت نشده.");
  return panel(env, chatId, msg, text, { inline_keyboard: kb });
}

async function listCategoryRoots(env, chatId, msg, page = 0) {
  const all = await listCategories(env, true);
  const explicitRoots = all.filter((x) => x.level === "کلی");
  const roots = explicitRoots.length
    ? explicitRoots
    : all.filter((x) => !x.parentIds.length);
  const pages = Math.max(1, Math.ceil(roots.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = roots.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = slice.map((root) => {
    const status = root.active ? "" : " (غیرفعال)";
    return [
      btn(
        `${root.icon} ${root.name}${status}`,
        `x:ca:${compactId(root.id)}`,
      ),
    ];
  });
  const nav = [];
  if (page > 0) nav.push(btn("◀️ قبلی", `x:cp:-:${page - 1}`));
  if (pages > 1) nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
  if (page < pages - 1) nav.push(btn("بعدی ▶️", `x:cp:-:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn("➕ دسته‌بندی جدید", "x:n:c")]);
  rows.push([btn("🏠 منوی اصلی", "m:home")]);
  return panel(
    env,
    chatId,
    msg,
    `🏷 <b>دسته‌بندی‌ها</b> — دسته‌های والد\nبرای دیدن زیر‌دسته‌ها یا مدیریت خود دسته، روی آن بزن.`,
    { inline_keyboard: rows },
  );
}

async function showCategoryRoot(env, chatId, msg, rootId) {
  const all = await listCategories(env, true);
  const root = all.find((x) => idEq(x.id, rootId));
  if (!root) return listCategoryRoots(env, chatId, msg, 0);
  const rows = [
    [btn("📂 مشاهده زیر‌دسته‌ها", `x:cs:${compactId(root.id)}:0`)],
    [btn("✏️ ویرایش همین دسته", `x:e:c:${compactId(root.id)}`)],
    [btn("🗑 حذف همین دسته", `x:d:c:${compactId(root.id)}`)],
    [btn("🔙 دسته‌های والد", "x:l:c:0")],
  ];
  return panel(
    env,
    chatId,
    msg,
    `${root.icon} <b>${esc(root.name)}</b>${root.active ? "" : "\nوضعیت: غیرفعال"}\nبرای مشاهده یا مدیریت زیر‌دسته‌ها، گزینه‌ی زیر را انتخاب کن.`,
    { inline_keyboard: rows },
  );
}

async function listCategoryChildren(env, chatId, msg, rootId, page = 0) {
  const all = await listCategories(env, true);
  const root = all.find((x) => idEq(x.id, rootId));
  if (!root) return listCategoryRoots(env, chatId, msg, 0);
  const children = all.filter((x) => x.parentIds.some((id) => idEq(id, root.id)));
  const pages = Math.max(1, Math.ceil(children.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = children.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = slice.map((child) => [
    btn(
      `${child.icon} ${child.name}${child.active ? "" : " (غیرفعال)"}`,
      `x:v:c:${compactId(child.id)}`,
    ),
  ]);
  const nav = [];
  if (page > 0) nav.push(btn("◀️ قبلی", `x:cp:${compactId(root.id)}:${page - 1}`));
  if (pages > 1) nav.push(btn(`${fa(page + 1)}/${fa(pages)}`, "m:noop"));
  if (page < pages - 1) nav.push(btn("بعدی ▶️", `x:cp:${compactId(root.id)}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn("➕ دسته‌بندی جدید", "x:n:c")]);
  rows.push([btn("🔙 بازگشت به والد", `x:ca:${compactId(root.id)}`)]);
  return panel(
    env,
    chatId,
    msg,
    `${root.icon} <b>${esc(root.name)}</b>\nزیر‌دسته‌ها را برای ویرایش یا حذف انتخاب کن:`,
    { inline_keyboard: rows },
  );
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
  if (e === "c") return { icon: pageEmoji(p), text: "" };
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
  const itemIcon = e === "c" ? pageEmoji(page) : ent.icon;
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
    lines.push(`${esc(p.name)}: <b>${esc(text)}</b>${money ? " تومان" : ""}`);
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
      [btn("✏️ ویرایش", `x:e:${e}:${cid}`), btn("🗑 حذف", `x:d:${e}:${cid}`)],
      [btn("🔙 فهرست", backToList), btn("🏠 منو", "m:home")],
    ],
  };
  return panel(env, chatId, msg, lines.join("\n"), kb);
}

/* ---- فیلدها: پرسیدن / دریافت مقدار ---- */

async function askField(env, chatId, msg, st, p, mode) {
  st.propName = p.name;
  st.opts = null;
  const displayName =
    st.ent === "a" && p.name === "مانده اولیه" ? "موجودی حساب" : p.name;
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
    st.opts = await relOptions(env, p, "");
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
  st.opts = await relOptions(env, p, text.trim());
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

async function startNew(env, chatId, msg, e) {
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
    const money = isMoneyField(st.ent, p.name);
    const displayName =
      st.ent === "a" && ["مانده اولیه", ACC.balance].includes(p.name)
        ? "موجودی حساب"
        : p.name;
    const value = money
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

async function showOverview(env, msg) {
  const cm = currentJMonth();
  const prev = cm.m === 1 ? { y: cm.y - 1, m: 12 } : { y: cm.y, m: cm.m - 1 };
  const [accounts, boxes, assets, thisMonth, lastMonth, categories] = await Promise.all([
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
    categories.map((category) => [compactId(category.id), `${category.icon} ${category.name}`]),
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
      return editPanel(env, msg, "⏸ بخش اهداف مالی فعلاً غیرفعال است.", backHome());
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
  return panel(env, chatId, msg, `📅 <b>۲. بازه‌ی گزارش</b>\n${esc(title)}${note}\n\nبازه را انتخاب کن:`, {
    inline_keyboard: [
      [btn("📅 امروز", "r:g:today"), btn("🗓 این ماه", "r:g:thism")],
      [btn("🗓 ماه قبل", "r:g:lastm"), btn("📆 انتخاب ماه", "r:g:pick")],
      [btn("✍️ روز / بازه‌ی دلخواه", "r:g:custom")],
      [btn("♾ همه‌ی زمان‌ها", "r:g:all")],
      [btn("🏠 منو", "m:home")],
    ],
  });
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
  for (const e of list) {
    try {
      const r =
        mode === "detail"
          ? await buildDetail(env, e, st.range)
          : await buildSummary(env, e, st.range, mode);
      if (!r.count && mode !== "detail") {
        await send(
          env,
          chatId,
          `ℹ️ ${esc(ENT[e].fa)}: داده‌ای در این بازه نبود.`,
        );
        continue;
      }
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
      await send(env, chatId, `⚠️ ${esc(ENT[e].fa)}: ${esc(err.message)}`);
    }
  }
  await clearState(env, chatId);
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
  assets: [AST.title, AST.type, AST.symbol, AST.unit, AST.qty, AST.price, AST.value],
};

function preparePdfReport(report, ent, mode) {
  const rows = parseCsvRows(report.csv);
  const header = rows.shift() || [];
  const allowed = new Set(PDF_DETAIL_COLUMNS[ent.key] || []);
  const kept = header
    .map((name, index) => ({
      name: name.trim(),
      index,
      canonicalName: name.trim().replace(/\s*\(تومان\)\s*$/, "").trim(),
    }))
    .filter(({ canonicalName }) => mode !== "detail" || allowed.has(canonicalName));
  if (!kept.length) return report;
  const outputRows = [
    kept.map(({ name }) => name),
    ...rows.map((row) =>
      kept.map(({ index, name }) => {
        const value = row[index] ?? "";
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
  if (p.type === "unique_id") return true;
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
  const normalizedName = String(p.name).replace(/\s/g, "").toLowerCase();
  return p.name === "مانده اولیه" || normalizedName === "appid";
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
      throw new Error(`ستون «${name}» باید رابطه‌ای به پایگاه‌داده حساب‌ها باشد`);
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
    .map((p) => ({
      id: p.id,
      name: propTitle(p, CAT.title),
      icon: pageEmoji(p),
      level: propChoice(p, CAT.level),
      active: propCheckbox(p, CAT.active) !== false,
      parentIds: (p.properties?.[CAT.parent]?.relation || []).map((r) => r.id),
    }))
    .filter((x) => x.name);
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
  return result;
}

const editPanel = (env, msg, text, keyboard) =>
  tg(env, "editMessageText", {
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard,
  });

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
