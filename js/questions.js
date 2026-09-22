export const MODEL = '~typesafe/jev-latest';

// Jev's state limit is 32k tokens including the longest question. Keeping the
// newest ~50k characters leaves generous room for that at ~4 chars per token.
const MAX_STATE_CHARS = 50_000;

// Each extra person only adds questions, which Jev answers in parallel for
// almost no extra time; the cap keeps the page readable, and 8 matches the
// number of identity colors.
export const MAX_SUBJECTS = 8;

const PERSONAL_QUESTIONS = {
  archetype: (name) => ({
    type: 'choice',
    instructions: `Which archetype fits ${name} best in this chat?`,
    criteria: {
      monologuer: 'Sends long or many messages, mostly about themselves',
      ghost: 'Replies rarely, late, or with the bare minimum',
      instigator: 'Provokes, stirs up conflict, or escalates',
      peacemaker: 'Smooths things over and keeps everyone comfortable',
      jester: 'Deflects with jokes, memes, or sarcasm',
      organiser: 'Drives plans, logistics, and decisions',
    },
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
 * Builds one Jev request that judges every subject at once. Question keys are
 * namespaced by subject index (`p0_drama`) so `readVerdicts` can split the
 * answers back out.
 */
export function buildRequest(messages, subjects) {
  const judged = newestWithinLimit(messages);
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
