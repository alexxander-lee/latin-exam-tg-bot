import 'dotenv/config';
import { Context, Telegraf } from 'telegraf';
import fs from 'fs';

interface TaskItem {
  question: string;
  answer: string;
}

interface Section {
  num: number;
  title: string;
  items: TaskItem[];
}


// --- Config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Set BOT_TOKEN env variable');
  process.exit(1);
}

// --- Types ---
interface WrongAnswer {
  question: string;
  correctAnswer: string;
  userAnswer: string;
}

interface Session {
  state: 'idle' | 'selecting' | 'testing';
  selectedSection?: number;
  questions?: (TaskItem & { sectionNum: number })[];
  currentIndex: number;
  correct: number;
  incorrect: number;
  wrongAnswers: WrongAnswer[];
}

// --- Parse tasks ---
const sections: Section[] = JSON.parse(fs.readFileSync('./src/data.json', { encoding: 'utf-8' }));

const SECTION_NAMES = sections.map(s => ({
  num: s.num,
  title: s.title,
  count: s.items.length,
}));

// --- State ---
const userSessions = new Map<number, Session>();

function getSession(userId: number): Session {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      state: 'idle',
      currentIndex: 0,
      correct: 0,
      incorrect: 0,
      wrongAnswers: [],
    });
  }
  return userSessions.get(userId)!;
}

function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[-;:!?|()\[\]\\]/g, '')
    .replace(/(?<!\d)[.,](?!\d)/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkAnswer(userAnswer: string, correctAnswer: string): boolean {
  return normalize(userAnswer) === normalize(correctAnswer);
}

// --- Keyboard builders ---
function sectionMenuKeyboard(selected?: number) {
  const rows = SECTION_NAMES.map(s => ([{
    text: `${selected === s.num ? '✅ ' : ''}${s.num} (${s.count})`,
    callback_data: `sel_${s.num}`,
  }]));
  rows.push([{ text: '✅ Начать тест', callback_data: 'start_test' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function sectionListText(selected?: number): string {
  return SECTION_NAMES.map(s =>
    `${selected === s.num ? '✅' : ''} ${s.num}. ${s.title} (${s.count})`
  ).join('\n');
}

// --- Bot ---
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const session = getSession(ctx.from.id);
  session.state = 'selecting';
  session.selectedSection = undefined;
  ctx.reply(
    `🇻🇦 Тест по латинскому языку\n\n${sectionListText()}\n\nВыберите раздел:`,
    sectionMenuKeyboard()
  );
});

bot.command('test', (ctx) => {
  const session = getSession(ctx.from.id);
  session.state = 'selecting';
  session.selectedSection = undefined;
  ctx.reply(
    `${sectionListText()}\n\nВыберите раздел:`,
    sectionMenuKeyboard()
  );
});

bot.command(['stop', 'cancel'], (ctx) => {
  const session = getSession(ctx.from.id);
  if (session.state === 'testing') {
    finishTest(ctx, session);
  } else {
    session.state = 'idle';
    ctx.reply('Отменено. /test — начать тест.');
  }
});

// Select single section
bot.action(/^sel_(\d+)$/, (ctx) => {
  const session = getSession(ctx.from.id);

  const num = parseInt(ctx.match[1]);
  session.selectedSection = session.selectedSection === num ? undefined : num;

  const s = session.selectedSection
    ? SECTION_NAMES.find(x => x.num === session.selectedSection)
    : null;
  const selectedText = s ? `${s.num}. ${s.title}` : 'Ничего не выбрано';

  ctx.answerCbQuery();
  ctx.editMessageText(
    `${sectionListText(session.selectedSection)}\n\nНажмите на раздел чтобы выбрать, затем «Начать тест».`,
    sectionMenuKeyboard(session.selectedSection)
  );
});

// Start test
bot.action('start_test', (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.selectedSection) {
    ctx.answerCbQuery('Выберите раздел!');
    return;
  }

  const section = sections.find(s => s.num === session.selectedSection)!;
  let questions: (TaskItem & { sectionNum: number })[] = section.items.map(item => ({
    ...item,
    sectionNum: section.num,
  }));

  // Shuffle (Fisher-Yates)
  for (let i = questions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [questions[i], questions[j]] = [questions[j], questions[i]];
  }

  session.state = 'testing';
  session.questions = questions;
  session.currentIndex = 0;
  session.correct = 0;
  session.incorrect = 0;
  session.wrongAnswers = [];

  ctx.answerCbQuery();
  ctx.reply(
    `Тест начат! Вопросов: ${questions.length}\n\n` +
    'Введите ответ на каждый вопрос.\n' +
    '/stop или /cancel — завершить досрочно.'
  );

  askQuestion(ctx, session);
});

function askQuestion(ctx: Context, session: Session) {
  if (session.currentIndex >= session.questions!.length) {
    finishTest(ctx, session);
    return;
  }

  const q = session.questions![session.currentIndex];
  ctx.reply(
    `[${session.currentIndex + 1}/${session.questions!.length}] ${q.question}`
  );
}

function finishTest(ctx: Context, session: Session) {
  const total = session.correct + session.incorrect;
  const wasAll = session.currentIndex >= (session.questions?.length ?? 0);

  let text = wasAll
    ? '📊 Тест завершён!\n\n'
    : `📊 Тест прерван на вопросе ${session.currentIndex + 1}/${session.questions!.length}\n\n`;

  text += `✅ Верно: ${session.correct}\n`;
  text += `❌ Неверно: ${session.incorrect}\n`;
  text += `📈 Ответов: ${total}\n`;

  if (total > 0) {
    text += `Процент: ${Math.round((session.correct / total) * 100)}%\n`;
  }

  if (session.wrongAnswers.length > 0) {
    text += '\n--- Неверно ---\n';
    for (const w of session.wrongAnswers) {
      text += `\n❓ ${w.question}\n`;
      text += `✅ ${w.correctAnswer}\n`;
      text += `📝 ${w.userAnswer}\n`;
    }
  }

  text += '\n/test — начать заново';
  session.state = 'idle';
  ctx.reply(text);
}

// Handle text answers
bot.on('text', async (ctx) => {
  const session = getSession(ctx.from.id);

  if (session.state !== 'testing') {
    if (ctx.message.text.startsWith('/')) return;
    ctx.reply('Начните тест: /test');
    return;
  }

  const userAnswer = ctx.message.text.trim();
  if (userAnswer.startsWith('/')) return;

  const q = session.questions![session.currentIndex];

  if (checkAnswer(userAnswer, q.answer)) {
    session.correct++;
    await ctx.reply('✅ Верно!');
  } else {
    session.incorrect++;
    session.wrongAnswers.push({
      question: q.question,
      correctAnswer: q.answer,
      userAnswer,
    });
    await ctx.reply(`❌ Неверно. Правильный ответ: ${q.answer}`);
  }

  session.currentIndex++;
  askQuestion(ctx, session);
});

bot.launch().then(() => console.log('Bot started'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
