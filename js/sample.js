// Sample chats, each in a different export format, so trying them also shows
// which formats the page reads. Their verdicts are judged once ahead of time
// (scripts/sample-verdicts.js) and replayed, see js/sample-verdicts.js.

export const SAMPLES = [
  {
    id: 'birthday',
    chat: `[2026-09-18, 19:02:11] Mara: ok team, Leo's birthday dinner. Saturday 8pm, I booked Trattoria Sole for 6. Can everyone confirm by tomorrow?
[2026-09-18, 19:03:40] Jonas: 👍
[2026-09-18, 19:15:02] Priya: Saturday works!! Should we do a group gift?
[2026-09-18, 19:16:45] Mara: Yes. I'll make a list. 20€ each?
[2026-09-18, 19:44:30] Tobi: saturday? I thought we said friday. I literally told everyone I'm at my cousin's wedding saturday
[2026-09-18, 19:45:12] Mara: Nobody said Friday, Tobi. I asked on Monday and you didn't answer.
[2026-09-18, 19:45:59] Tobi: wow ok. nice to know my schedule doesn't matter I guess
[2026-09-18, 19:46:20] Priya: Guys it's fine!! We can find a day that works for everyone 😊
[2026-09-18, 19:46:48] Jonas: lol
[2026-09-18, 19:52:03] Tobi: honestly this always happens. last year I also found out about the hiking trip from instagram. but sure, go ahead without me, it's totally fine, I'm used to it by now
[2026-09-18, 19:53:30] Tobi: not that anyone asked but the wedding is actually a big deal for my family, I'm giving a speech and I've been working on it for weeks
[2026-09-18, 19:54:01] Mara: Tobi, can you do Sunday lunch instead? Yes or no.
[2026-09-18, 20:10:44] Tobi: I'll see
[2026-09-18, 20:11:05] Mara: Jonas, are you in for the gift?
[2026-09-18, 21:30:00] Jonas: 🙃
[2026-09-18, 21:31:12] Priya: Maybe we just do both? Dinner Saturday and a little brunch Sunday so Tobi can come too? I can bake a cake!! 🎂
[2026-09-18, 21:33:40] Mara: Fine. Saturday stays. Sunday brunch is optional. Gift list is pinned, pay me by Thursday please.
[2026-09-18, 21:34:02] Tobi: "optional" 🙂
[2026-09-18, 21:34:30] Jonas: can someone tell me what's happening`,
  },
  {
    // Two people, so it gets the duo verdict. WhatsApp on Android, German.
    id: 'ikea',
    chat: `24.10.26, 10:02 - Lena: IKEA heute? Ich brauch nur Teelichter
24.10.26, 10:03 - Tim: das hast du letztes mal auch gesagt und wir kamen mit einem sofa raus
24.10.26, 10:03 - Lena: Das Sofa war ein Notfall
24.10.26, 10:04 - Tim: es war 23 uhr an einem dienstag
24.10.26, 10:05 - Lena: Holst du mich um 2 ab? Und nimm die blauen Taschen mit, nicht die gelben
24.10.26, 10:05 - Tim: die gelben SIND die blauen lena
24.10.26, 10:06 - Lena: Die anderen gelben
24.10.26, 10:07 - Tim: ok. 14 uhr. ich ess vorher, sonst wird's wieder wie im märz
24.10.26, 10:08 - Lena: Wir reden nicht über März
24.10.26, 13:58 - Tim: bin unten
24.10.26, 14:20 - Lena: 2 Min!!
24.10.26, 14:31 - Tim: das waren 11
24.10.26, 16:45 - Lena: Wo bist du? Ich bin bei den Pflanzen
24.10.26, 16:46 - Tim: bei den köttbullar. wie immer. wie jedes mal. seit 2019
24.10.26, 16:46 - Lena: Bring mir welche mit 🥺
24.10.26, 16:47 - Tim: hab schon 2 portionen. eine ist für dich, ich kenn dich
24.10.26, 18:10 - Lena: Danke fürs Fahren ❤️ Teelichter hab ich übrigens vergessen
24.10.26, 18:11 - Tim: natürlich hast du das. nächsten samstag?
24.10.26, 18:11 - Lena: Nächsten Samstag 🫶`,
  },
  {
    // WhatsApp on Android, day first.
    id: 'flatmates',
    chat: `14/10/2026, 21:02 - Sam: Hi all 🙂 just a gentle reminder that the sink is not a storage area
14/10/2026, 21:03 - Sam: No names. Just someone's frying pan has been "soaking" since Sunday 🙂
14/10/2026, 21:10 - Nora: omg sorry if that's me!!! I'll check when I'm home 💛💛
14/10/2026, 21:11 - Elif: Technically soaking only helps for the first few hours. After that the starch re-hardens, it's actually counterproductive
14/10/2026, 21:11 - Elif: Also cast iron shouldn't soak at all, it rusts
14/10/2026, 21:25 - Sam: Good to know, Elif. Maybe the owner of the cast iron pan would like to know too 🙂
14/10/2026, 22:47 - Dario: mine
14/10/2026, 22:47 - Dario: tmrw
15/10/2026, 07:30 - Nora: Good morning!! I made a cleaning rota so nobody has to remind anyone 🥰 Can everyone pick a week? I'll take bathroom first!
15/10/2026, 07:31 - Nora: <Media omitted>
15/10/2026, 08:15 - Elif: The rota is good but it should rotate by task, not by week. Otherwise the person with the bathroom always gets the bathroom. I can make a spreadsheet
15/10/2026, 08:16 - Sam: Love that we need a spreadsheet to wash one pan 🙂
15/10/2026, 12:40 - Nora: Spreadsheet sounds amazing Elif!! You're the best ✨
15/10/2026, 19:58 - Sam: Pan update: still soaking 🙂 It has become part of the kitchen. I've started greeting it
15/10/2026, 23:51 - Dario: done
16/10/2026, 07:02 - Elif: For the record, it's rusted now. I said it would
16/10/2026, 07:04 - Nora: It's ok!!! Rust can be fixed! Dario I can show you how to season it 🍳💛
16/10/2026, 09:30 - Dario: ok`,
  },
  {
    // WhatsApp on an iPhone set to German.
    id: 'zocken',
    chat: `[23.10.26, 18:20:11] Kevin: wer ist heute on
[23.10.26, 18:20:40] Max: Ich. 20 Uhr. Wer zu spät kommt, spielt Support.
[23.10.26, 18:22:05] Jule: ich bring snacks. und eine gummiente als maskottchen. sie heißt Gerhard 🦆
[23.10.26, 18:22:06] Jule: <Media omitted>
[23.10.26, 18:23:17] Ben: same
[23.10.26, 18:30:44] Kevin: Max du warst gestern so schlecht dass ich dachte mein Bildschirm hat nen Bug 😂
[23.10.26, 18:31:02] Max: Ich hatte 14 Kills.
[23.10.26, 18:31:30] Kevin: davon 10 gegen bots lol
[23.10.26, 18:32:12] Ben: lol
[23.10.26, 18:40:51] Jule: unwichtig aber tintenfische haben drei herzen. wenn wir verlieren opfere ich Gerhard. das ist kein witz
[23.10.26, 18:41:30] Max: Jule. Fokus.
[23.10.26, 18:41:44] Jule: ich hab gerade beschlossen dass ich heute nur mit einer pfanne spiele 🍳
[23.10.26, 19:58:03] Max: Bin drin. Lobby ist offen.
[23.10.26, 20:14:27] Kevin: sorry pizza
[23.10.26, 20:14:40] Max: Support.
[23.10.26, 20:14:59] Kevin: das ist mobbing ich ruf die polizei
[23.10.26, 20:15:20] Ben: same
[23.10.26, 23:48:09] Jule: gg. ich hab 40 minuten nur getanzt, Gerhard hat zugeschaut, wir haben trotzdem gewonnen. ich glaube Gerhard ist der wahre MVP 🦆🕺
[23.10.26, 23:48:31] Kevin: wir haben gewonnen WEIL ich support war. merkt euch das
[23.10.26, 23:49:02] Max: Morgen gleiche Zeit.
[23.10.26, 23:49:10] Ben: same`,
  },
  {
    // WhatsApp on Android, German date format.
    id: 'familie',
    chat: `25.10.26, 08:03 - Mama: Guten Morgen ihr Lieben ☀️ Denkt dran, heute Mittag 13 Uhr bei Oma! Wer bringt den Salat? Lea, hast du Omas Geschenk?
25.10.26, 08:04 - Mama: Und bitte Jacken mitnehmen, es soll regnen
25.10.26, 08:40 - Papa: Laut Wetterdienst nur 30 % Regenwahrscheinlichkeit. Das heißt übrigens nicht, dass es 30 % der Zeit regnet, sondern an 30 % der Orte im Gebiet
25.10.26, 08:41 - Mama: Jacken. Bitte.
25.10.26, 09:15 - Finn: kann ich später kommen? hab gestern erst um 4 aufgehört an meinem podcast zu schneiden. folge 3 ist online übrigens, hört rein, das intro hab ich komplett selbst gemacht
25.10.26, 09:17 - Finn: ehrlich gesagt ist das gerade wichtiger für mich als ein mittagessen. ihr wisst wie viel ich da reinstecke. keiner hier hat folge 2 kommentiert btw
25.10.26, 09:16 - Finn: <Media omitted>
25.10.26, 09:30 - Mama: Toll Finn! 13 Uhr bitte trotzdem. Oma freut sich so
25.10.26, 10:02 - Papa: Kleiner Hinweis: Podcasts zählen bei Oma nicht als Entschuldigung. Ich habe es 1997 mit dem Radio versucht
25.10.26, 11:47 - Mama: Lea?
25.10.26, 11:48 - Mama: Lea hast du das Geschenk?
25.10.26, 12:30 - Finn: ok ich komm. aber kann ich oma folge 3 vorspielen? ist eh nur 90 min
25.10.26, 12:58 - Lea: ich hab euch gehört. alle zwölf nachrichten
25.10.26, 12:58 - Lea: bin schon da. oma und ich essen den salat. das geschenk ist eine überraschung, auch für mich
25.10.26, 12:59 - Mama: Lea!! Den Salat sollten DIE ANDEREN bringen 😅 Ich hab doch extra gefragt
25.10.26, 13:05 - Finn: kann jemand oma sagen dass sie mich gleich nach dem essen interviewen soll? für folge 4. ich hab schon fragen vorbereitet, eigentlich geht's eher um mich
25.10.26, 13:20 - Papa: Bin unterwegs. Ohne Jacke. Es regnet nicht
25.10.26, 13:34 - Papa: Es regnet
25.10.26, 13:36 - Lea: wir haben dir salat übrig gelassen papa. also den teller`,
  },
  {
    // WhatsApp in the US: month first, 12-hour clock.
    id: 'lisbon',
    chat: `10/12/26, 9:15 PM - Chris: OK Lisbon is happening. I found flights, I'm basically the travel agent now so you're welcome
10/12/26, 9:16 PM - Chris: Also I'm taking the room with the balcony, I'm the one who found the place
10/12/26, 9:20 PM - Jess: LISBON!!! I'm so in!!! 🇵🇹🇵🇹 I'll do a pastel de nata ranking spreadsheet 🥳
10/12/26, 9:34 PM - Ava: wait so nobody even asked if I can make those dates? cool cool
10/12/26, 9:35 PM - Chris: I posted them in the group last week
10/12/26, 9:41 PM - Ava: I was literally at my grandma's 80th that whole weekend. I can't believe nobody thought of that. Whatever, book it, I'll just stay home and look at your pictures
10/12/26, 9:42 PM - Jess: Ava noooo 😭 we can move it!!! We'll find dates that work for you 💛
10/12/26, 9:50 PM - Chris: Moving it means new flights. These are the cheapest. I already did all the research
10/12/26, 11:58 PM - Mo: what dates
10/12/26, 11:59 PM - Chris: They're literally in the message above Mo
10/13/26, 8:03 AM - Mo: I'm free the week after. I'll book on my own if needed
10/13/26, 8:30 AM - Ava: oh so Mo gets a choice and I don't
10/13/26, 8:31 AM - Jess: Everyone gets a choice!!! Let's vote!!! 🗳️
10/13/26, 8:31 AM - Jess: <Media omitted>
10/13/26, 9:12 AM - Chris: Fine, vote. But I'm keeping the balcony either way
10/13/26, 12:47 PM - Mo: 👍`,
  },
];
