import 'dotenv/config';
import { Context, Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

// =========================
// Config
// =========================

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN env variable is required');
  process.exit(1);
}

const MAX_MESSAGE_LENGTH = 4000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24;

// =========================
// Types
// =========================

enum SessionState {
  IDLE = 'idle',
  SELECTING = 'selecting',
  TESTING = 'testing',
}

interface TaskItem {
  question: string;
  answer: string;
}

interface Section {
  num: number;
  title: string;
  items: TaskItem[];
}

interface WrongAnswer {
  question: string;
  correctAnswer: string;
  userAnswer: string;
}

interface QuestionItem extends TaskItem {
  sectionNum: number;
}

interface Session {
  state: SessionState;
  selectedSection?: number;
  questions?: QuestionItem[];
  currentIndex: number;
  correct: number;
  incorrect: number;
  wrongAnswers: WrongAnswer[];
  updatedAt: number;
  processing: boolean;
}

// =========================
// Validation Schemas
// =========================

const TaskItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});

const SectionSchema = z.object({
  num: z.number(),
  title: z.string().min(1),
  items: z.array(TaskItemSchema),
});

const SectionsSchema = z.array(SectionSchema);

// =========================
// Load data.json
// =========================

function loadSections(): Section[] {
  try {
    const filePath = path.resolve(__dirname, './data.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    return SectionsSchema.parse(parsed);
  } catch (error) {
    console.error('Failed to load or validate data.json');
    console.error(error);
    process.exit(1);
  }
}

const sections = loadSections();

const SECTION_NAMES = sections.map(section => ({
  num: section.num,
  title: section.title,
  count: section.items.length,
}));

// =========================
// Session Manager
// =========================

class SessionManager {
  private sessions = new Map<number, Session>();

  get(userId: number): Session {
    let session = this.sessions.get(userId);

    if (!session) {
      session = this.create();
      this.sessions.set(userId, session);
    }

    session.updatedAt = Date.now();

    return session;
  }

  delete(userId: number): void {
    this.sessions.delete(userId);
  }

  cleanup(): void {
    const now = Date.now();

    for (const [userId, session] of this.sessions.entries()) {
      if (now - session.updatedAt > SESSION_TTL_MS) {
        this.sessions.delete(userId);
      }
    }
  }

  private create(): Session {
    return {
      state: SessionState.IDLE,
      currentIndex: 0,
      correct: 0,
      incorrect: 0,
      wrongAnswers: [],
      updatedAt: Date.now(),
      processing: false,
    };
  }
}

const sessionManager = new SessionManager();

setInterval(() => {
  sessionManager.cleanup();
}, 1000 * 60 * 10);

// =========================
// Utils
// =========================

/**
 * Normalize answers:
 * - ignore case
 * - ignore punctuation
 * - preserve decimal separators inside numbers
 * - collapse spaces
 */
function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/\n[-;:!?|()\[\]\\]/g, ' ')
    .replace(/(?<!\d)[.,](?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkAnswer(userAnswer: string, correctAnswer: string): boolean {
  return normalizeAnswer(userAnswer) === normalizeAnswer(correctAnswer);
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

async function safeReply(ctx: Context, text: string): Promise<void> {
  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];

  for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
    chunks.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
  }

  return chunks;
}

// =========================
// UI
// =========================

function sectionMenuKeyboard(selected?: number) {
  const rows = SECTION_NAMES.map(section => [
    {
      text: `${selected === section.num ? '✅ ' : ''}${section.num} (${section.count})`,
      callback_data: `sel_${section.num}`,
    },
  ]);

  rows.push([
    {
      text: '✅ Начать тест',
      callback_data: 'start_test',
    },
  ]);

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function sectionListText(selected?: number): string {
  return SECTION_NAMES.map((section) => {
    return `${selected === section.num ? '✅' : ''} ${section.num}. ${section.title} (${section.count})`;
  }).join('\n');
}

// =========================
// Bot
// =========================

const bot = new Telegraf(BOT_TOKEN);

async function startSelection(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const session = sessionManager.get(ctx.from.id);

  session.state = SessionState.SELECTING;
  session.selectedSection = undefined;
  session.questions = undefined;
  session.currentIndex = 0;
  session.correct = 0;
  session.incorrect = 0;
  session.wrongAnswers = [];

  await ctx.reply(
    `🇻🇦 Тест по латинскому языку\n\n${sectionListText()}\n\nВыберите раздел:`,
    sectionMenuKeyboard(),
  );
}

bot.start((ctx) => startSelection(ctx));

bot.command('test', (ctx) => startSelection(ctx));

bot.command(['stop', 'cancel'], async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const session = sessionManager.get(ctx.from.id);

  if (session.state !== SessionState.TESTING) {
    sessionManager.delete(ctx.from.id);
    await ctx.reply('Тест отменён. /test — начать заново');
    return;
  }

  await finishTest(ctx, session);
});

// =========================
// Select section
// =========================

bot.action(/^sel_(\d+)$/, async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const session = sessionManager.get(ctx.from.id);

  if (session.state !== SessionState.SELECTING) {
    await ctx.answerCbQuery('Сначала начните новый тест');
    return;
  }

  const num = Number(ctx.match[1]);

  const sectionExists = sections.some((section) => section.num === num);

  if (!sectionExists) {
    await ctx.answerCbQuery('Раздел не найден');
    return;
  }

  session.selectedSection = session.selectedSection === num
    ? undefined
    : num;

  await ctx.answerCbQuery();

  await ctx.editMessageText(
    `${sectionListText(session.selectedSection)}\n\nНажмите на раздел чтобы выбрать, затем «Начать тест».`,
    sectionMenuKeyboard(session.selectedSection),
  );
});

// =========================
// Start test
// =========================

bot.action('start_test', async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const session = sessionManager.get(ctx.from.id);

  if (session.state !== SessionState.SELECTING) {
    await ctx.answerCbQuery('Тест уже запущен');
    return;
  }

  if (!session.selectedSection) {
    await ctx.answerCbQuery('Выберите раздел');
    return;
  }

  const section = sections.find(s => s.num === session.selectedSection);

  if (!section) {
    await ctx.answerCbQuery('Раздел не найден');
    return;
  }

  const questions = shuffle(
    section.items.map(item => ({
      ...item,
      sectionNum: section.num,
    })),
  );

  session.state = SessionState.TESTING;
  session.questions = questions;
  session.currentIndex = 0;
  session.correct = 0;
  session.incorrect = 0;
  session.wrongAnswers = [];

  await ctx.answerCbQuery();

  await ctx.reply(
    `Тест начат! Вопросов: ${questions.length}\n\n` +
      'Введите ответ на каждый вопрос.\n' +
      '/stop или /cancel — завершить тест досрочно.',
  );

  await askQuestion(ctx, session);
});

// =========================
// Ask question
// =========================

async function askQuestion(ctx: Context, session: Session): Promise<void> {
  const questions = session.questions;

  if (!questions) {
    await ctx.reply('Ошибка: вопросы не найдены');
    return;
  }

  if (session.currentIndex >= questions.length) {
    await finishTest(ctx, session);
    return;
  }

  const question = questions[session.currentIndex];

  await ctx.reply(`[${session.currentIndex + 1}/${questions.length}] ${question.question}`);
}

// =========================
// Finish test
// =========================

async function finishTest(ctx: Context, session: Session): Promise<void> {
  const total = session.correct + session.incorrect;
  const totalQuestions = session.questions?.length ?? 0;

  const wasCompleted = session.currentIndex >= totalQuestions;

  let text = wasCompleted
    ? '📊 Тест завершён!\n\n'
    : `📊 Тест прерван на вопросе ${session.currentIndex + 1}/${totalQuestions}\n\n`;

  text += `✅ Верно: ${session.correct}\n`;
  text += `❌ Неверно: ${session.incorrect}\n`;
  text += `📈 Ответов: ${total}\n`;

  if (total > 0) {
    const percent = Math.round((session.correct / total) * 100);
    text += `🎯 Процент: ${percent}%\n`;
  }

  if (session.wrongAnswers.length > 0) {
    text += '\n--- Неверные ответы ---\n';

    for (const wrong of session.wrongAnswers) {
      text += `\n❓ ${wrong.question}\n`;
      text += `✅ Правильный ответ: ${wrong.correctAnswer}\n`;
      text += `📝 Ваш ответ: ${wrong.userAnswer}\n`;
    }
  }

  text += '\n/test — начать заново';

  await safeReply(ctx, text);

  if (ctx.from) {
    sessionManager.delete(ctx.from.id);
  }
}

// =========================
// Text answers
// =========================

bot.on('text', async (ctx) => {
  if (!ctx.from) {
    return;
  }

  const session = sessionManager.get(ctx.from.id);

  if (session.processing) {
    return;
  }

  if (session.state !== SessionState.TESTING) {
    if (ctx.message.text.startsWith('/')) {
      return;
    }

    await ctx.reply('Используйте /test чтобы начать тест');
    return;
  }

  session.processing = true;

  try {
    const userAnswer = ctx.message.text.trim();

    if (userAnswer.startsWith('/')) {
      return;
    }

    const questions = session.questions;

    if (!questions) {
      await ctx.reply('Ошибка: тест не найден');
      return;
    }

    const question = questions[session.currentIndex];

    if (!question) {
      await finishTest(ctx, session);
      return;
    }

    if (checkAnswer(userAnswer, question.answer)) {
      session.correct += 1;
      await ctx.reply('✅ Верно');
    } else {
      session.incorrect += 1;

      session.wrongAnswers.push({
        question: question.question,
        correctAnswer: question.answer,
        userAnswer,
      });

      await ctx.reply(`❌ Неверно. Правильный ответ: ${question.answer}`);
    }

    session.currentIndex += 1;

    await askQuestion(ctx, session);
  } finally {
    session.processing = false;
  }
});

// =========================
// Error handling
// =========================

bot.catch(async (error, ctx) => {
  console.error('Bot error:', error);

  try {
    await ctx.reply('Произошла ошибка. Попробуйте снова позже.');
  } catch (replyError) {
    console.error('Failed to send error message:', replyError);
  }
});

// =========================
// Start bot
// =========================

bot.launch()
  .then(() => console.log('Bot started'))
  .catch((error) => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
