import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import {
  BOT_TOKEN,
  AI_MODELS,
  DOCTOR_BIAS,
} from "./config.js";
import {
  DB_PATH,
  rememberMessage,
  getLongTermMemories,
  deleteLongTermMemoryLike,
  closeDb,
} from "./db.js";
import {
  displayName,
  roleFromUser,
  roleLabel,
  looksSensitive,
  inferMemorySubjects,
  extractManualMemory,
  maybeStoreHighSignalFact,
  normalizeMemory,
  saveLongTermMemory,
} from "./memory.js";
import {
  isDirectlyAddressed,
  interventionProbability,
} from "./behavior.js";
import { generateAIReply } from "./ai.js";

const bot = new Telegraf(BOT_TOKEN);

async function sendNargesReply(
  ctx,
  { direct = false, currentText = null } = {}
) {
  await ctx.sendChatAction("typing");

  const result = await generateAIReply(ctx, {
    direct,
    currentText,
  });

  const sent = await ctx.reply(result.reply, {
    reply_parameters: { message_id: ctx.message.message_id },
  });

  rememberMessage(
    ctx.chat.id,
    "نرگس کوچولو",
    result.reply,
    ctx.botInfo?.id || null
  );

  return sent;
}

function memoryListText() {
  const engineer = getLongTermMemories("engineer", 12);
  const doctor = getLongTermMemories("doctor", 12);

  const render = (title, rows) => {
    if (!rows.length) return `${title}: هنوز چیزی ندارم.`;
    return `${title}:\n${rows.map((x) => `• ${x.content}`).join("\n")}`;
  };

  return `${render("مهندس", engineer)}\n\n${render("خانوم دکتر", doctor)}`;
}

bot.start(async (ctx) => {
  await ctx.reply(
    "من نرگس کوچولوام 😌 هم حافظه دارم، هم مودم رو از روی بحث عوض می‌کنم، هم اگه بحث جالب بشه خودم می‌پرم وسط 😂\n\n/id آیدی عددی\n/ping تست\n/memory چیزایی که یادمه"
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(
    `آیدی عددی شما: ${ctx.from.id}\nآیدی این چت: ${ctx.chat.id}`
  );
});

bot.command("ping", async (ctx) => {
  await ctx.reply(
    "بیدارم 😌 خانوم دکتر خیالتون راحت، مهندس هنوز تحت نظارته 😂"
  );
});

bot.command("memory", async (ctx) => {
  await ctx.reply(memoryListText());
});

bot.command("remember", async (ctx) => {
  const text = ctx.message.text
    .replace(/^\/remember(@\w+)?\s*/i, "")
    .trim();

  if (!text) {
    await ctx.reply("بعد از /remember بگو چی رو یادم بمونه 😌");
    return;
  }

  if (looksSensitive(text)) {
    await ctx.reply(
      "این یکی زیادی حساسه؛ رمز، توکن، اطلاعات مالی و چیزای خصوصی رو تو حافظه‌م نگه نمی‌دارم 🌱"
    );
    return;
  }

  const speakerRole = roleFromUser(ctx.from);
  const subjects = inferMemorySubjects(text, speakerRole);

  if (!subjects.length) {
    await ctx.reply("بگو اینو درباره مهندس یادم بمونه یا خانوم دکتر 😄");
    return;
  }

  const saved = subjects.filter((subject) =>
    saveLongTermMemory(subject, text, {
      importance: 3,
      source: "manual",
    })
  );

  await ctx.reply(
    saved.length
      ? `باشه، یادم موند برای ${saved.map(roleLabel).join(" و ")} 😌`
      : "این مورد رو نتونستم ذخیره کنم."
  );
});

bot.command("forget", async (ctx) => {
  const text = ctx.message.text
    .replace(/^\/forget(@\w+)?\s*/i, "")
    .trim();

  if (!text) {
    await ctx.reply(
      "بعد از /forget یه کلمه یا جمله از چیزی که می‌خوای فراموش کنم بنویس."
    );
    return;
  }

  const speakerRole = roleFromUser(ctx.from);
  const subjects = inferMemorySubjects(text, speakerRole);
  const targetSubjects = subjects.length
    ? subjects
    : ["engineer", "doctor"];

  const needle = normalizeMemory(text);
  let changes = 0;

  for (const subject of targetSubjects) {
    changes += deleteLongTermMemoryLike(subject, needle);
  }

  await ctx.reply(
    changes
      ? "اوکی، اون مورد از حافظه بلندمدتم پاک شد."
      : "چیزی با این مشخصات تو حافظه‌م پیدا نکردم."
  );
});

bot.command("narges", async (ctx) => {
  const text = ctx.message.text
    .replace(/^\/narges(@\w+)?\s*/i, "")
    .trim();

  const currentText = text || "نرگس";

  rememberMessage(
    ctx.chat.id,
    displayName(ctx.from),
    currentText,
    ctx.from.id
  );

  maybeStoreHighSignalFact(ctx.from, currentText);

  await sendNargesReply(ctx, {
    direct: true,
    currentText,
  });
});

bot.on(message("text"), async (ctx) => {
  if (!ctx.from || ctx.from.is_bot) return;

  const text = ctx.message.text?.trim();
  if (!text || text.startsWith("/")) return;

  const speaker = displayName(ctx.from);
  const speakerRole = roleFromUser(ctx.from);

  rememberMessage(ctx.chat.id, speaker, text, ctx.from.id);
  maybeStoreHighSignalFact(ctx.from, text);

  const manualMemory = extractManualMemory(text, speakerRole);

  if (manualMemory) {
    if (looksSensitive(manualMemory.content)) {
      await ctx.reply(
        "این یکی رو تو حافظه بلندمدت نگه نمی‌دارم؛ چیزهای حساس و خصوصی بهتره ذخیره نشن 🌱"
      );
      return;
    }

    const saved = manualMemory.subjects.filter((subject) =>
      saveLongTermMemory(subject, manualMemory.content, {
        importance: 3,
        source: "manual-natural",
      })
    );

    if (saved.length) {
      const confirmation =
        `باشه، اینو درباره ${saved.map(roleLabel).join(" و ")} یادم می‌مونه 😌`;

      await ctx.reply(confirmation, {
        reply_parameters: { message_id: ctx.message.message_id },
      });

      rememberMessage(
        ctx.chat.id,
        "نرگس کوچولو",
        confirmation,
        ctx.botInfo?.id || null
      );

      return;
    }
  }

  const direct = isDirectlyAddressed(ctx, text);

  if (direct) {
    await sendNargesReply(ctx, {
      direct: true,
      currentText: text,
    });
    return;
  }

  const probability = interventionProbability(ctx, text);

  if (Math.random() >= probability) return;

  await sendNargesReply(ctx, {
    direct: false,
    currentText: text,
  });
});

bot.catch((error, ctx) => {
  console.error(
    `Telegram error in update ${ctx.update?.update_id}:`,
    error
  );
});

bot.launch()
  .then(() => {
    console.log("🌸 نرگس کوچولو V2 بیدار شد!");
    console.log(`🤖 AI models: ${AI_MODELS.join(", ")}`);
    console.log(`🧠 Memory DB: ${DB_PATH}`);
    console.log(
      `👩‍⚕️ Doctor bias in banter: ${Math.round(DOCTOR_BIAS * 100)}%`
    );
  })
  .catch((error) => {
    console.error("Failed to start Telegram bot:", error);
    process.exit(1);
  });

function shutdown(signal) {
  try {
    bot.stop(signal);
  } finally {
    closeDb();
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
