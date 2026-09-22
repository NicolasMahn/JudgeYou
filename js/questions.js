export const MODEL = '~typesafe/jev-latest';

// Jev's state limit is 32k tokens including the longest question. Keeping the
// newest ~50k characters leaves generous room for that at ~4 chars per token.
const MAX_STATE_CHARS = 50_000;

// Each extra person only adds questions, which Jev answers in parallel for
// almost no extra time; the cap keeps the results page readable.
export const MAX_SUBJECTS = 8;

// Option keys match TYPES in presentation.js; the descriptions are what Jev
// actually judges against, so they describe behaviour visible in text.
const TYPE_CRITERIA = {
  giga_chad: 'Unbothered and self-assured; short, decisive messages; never explains or apologises',
  golden_retriever: 'Relentlessly enthusiastic and supportive; exclamation marks; happy about everything',
  cat: 'Aloof; replies only when it suits them; ignores questions; occasional sass',
  chaos_goblin: 'Random and unhinged; memes, derailing tangents, chaotic energy',
  dragon: 'Dominates the chat and makes it about themselves; gets fiery when challenged',
  owl: 'Know-it-all; corrects others, over-explains, cites facts',
  sloth: 'Minimum effort; one-word replies, reactions, "k"',
  mother_hen: 'Organises everyone; makes plans, sends reminders, collects money, herds the group',
  troll: 'Provokes on purpose; contrarian bait; mocks others for fun',
  drama_llama: 'Turns small things into a crisis; hurt feelings, guilt trips, "it\'s fine" when it is not',
  mosquito: 'Small, persistent passive-aggressive jabs; sarcastic quotes and snide remarks',
  npc: 'Generic, agreeable filler replies like "same", "lol", "haha"; no opinions of their own',
};

const PERSONAL_QUESTIONS = {
  type: (name) => ({
    type: 'choice',
    instructions: `Which type describes how ${name} behaves in this chat?`,
    criteria: TYPE_CRITERIA,
  }),
  passive_aggression: (name) => ({
    type: 'score',
    instructions: `How passive-aggressive is ${name}?`,
    criteria: [
      'Says what they mean, kindly',
      'An occasional pointed remark',
      'Regular veiled digs',
      'Weaponised politeness in most messages',
    ],
  }),
  main_character: (name) => ({
    type: 'score',
    instructions: `How much does ${name} make the conversation about themselves?`,
    criteria: [
      'Mostly asks about and responds to others',
      'Takes a fair share of the attention',
      'Often steers topics back to themselves',
      'Everyone else is a supporting character',
    ],
  }),
  effort: (name) => ({
    type: 'score',
    instructions: `How much effort does ${name} put into their messages?`,
    criteria: [
      'One-word replies and reactions only',
      'Short but relevant replies',
      'Thoughtful, complete replies',
      'Essays nobody asked for',
    ],
  }),
  drama: (name) => ({
    type: 'score',
    instructions: `How much drama does ${name} generate?`,
    criteria: [
      'Calm and steady throughout',
      'Mildly excitable',
      'Frequently escalates small things',
      'Every message is an emergency',
    ],
  }),
  started_it: (name) => ({
    type: 'noul',
    instructions: `${name} started the main disagreement or tension in this chat.`,
  }),
  leaves_on_read: (name) => ({
    type: 'noul',
    instructions: `${name} ignores or dodges direct questions from others.`,
  }),
  secretly_right: (name) => ({
    type: 'noul',
    instructions: `${name} holds the most reasonable position in this chat.`,
  }),
};

const CULPRIT = 'culprit';

function newestWithinLimit(messages) {
  const kept = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    chars += messages[i].author.length + messages[i].text.length;
    if (chars > MAX_STATE_CHARS) break;
    kept.unshift(messages[i]);
  }
  return kept;
}

/**
 * Builds one Jev request that judges every subject at once. `chat` is either
 * parsed messages or, when the format wasn't recognised, the raw text. Question
 * keys are namespaced by subject index (`p0_drama`) so `readVerdicts` can split
 * the answers back out.
 */
export function buildRequest(chat, subjects) {
  const questions = {
    [CULPRIT]: {
      type: 'choice',
      instructions: 'Who is most responsible for the tension or drama in this chat?',
      criteria: Object.fromEntries(subjects.map((name) => [name, null])),
    },
  };

  subjects.forEach((name, i) => {
    for (const [key, question] of Object.entries(PERSONAL_QUESTIONS)) {
      questions[`p${i}_${key}`] = question(name);
    }
  });

  if (typeof chat === 'string') {
    return {
      judgedCount: null,
      body: { model: MODEL, state: { participants: subjects, transcript: chat.slice(-MAX_STATE_CHARS) }, questions },
    };
  }

  const judged = newestWithinLimit(chat);
  return {
    judgedCount: judged.length,
    body: {
      model: MODEL,
      state: { messages: judged.map(({ author, text }) => ({ from: author, text })) },
      questions,
    },
  };
}

export function readVerdicts(answers, subjects) {
  return {
    culprit: answers[CULPRIT],
    people: subjects.map((name, i) => ({
      name,
      answers: Object.fromEntries(
        Object.keys(PERSONAL_QUESTIONS).map((key) => [key, answers[`p${i}_${key}`]]),
      ),
    })),
  };
}
