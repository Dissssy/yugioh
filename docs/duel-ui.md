# Duel screen: look and feel

As of 2026-11-18. This is the plan for making the duel screen feel like a card table rather than a web form. It sits on top of [architecture.md](architecture.md) (the engine and its build layers) and [duels.md](duels.md) (what layer 1 built). Nothing here changes who owns the rules: the board only ever offers what `legalActions` returns, and the server checks every intent again.

## Where we are

Layer 1's board (`web/src/board/`) works but reads as a page of boxes:

- The table sits inside the site's normal page with its header, and the whole page scrolls.
- The hand is a wrapping row of small cards. Nothing tells you which ones you can play.
- Every action goes through a list of buttons in the sidebar, away from the card it acts on.
- Hovering any card swaps the big image in the sidebar, so the sidebar flickers as the mouse crosses the board, and the log gets pushed down below it.
- Cards already glide between zones (Motion `layoutId`), but there is nothing for the moments that matter: no summon impact, no attack, no damage number, no turn banner. LP just changes.
- The log is plain strings with no structure, so it can't show automated rulings or hold a Contest button later.

## Principles

1. **The board is the interface.** You act on cards where they are: drag them, or click them and get a menu next to the card. The sidebar is for the log, not for controls.
2. **Show what's possible, quietly.** Playable cards have a soft glow. While you drag or choose, legal places light up and everything else dims.
3. **Every state change is seen.** The server tells the client what happened, not only the result, and the client plays it as a short animation before settling on the new board.
4. **The UI never leaks hidden information.** Animations, timings and hover effects are the same whatever the hidden card is. (Details under "Hidden information".)
5. **Fast by default.** Animations are short (most under 400 ms), never block input longer than they play, and there is a speed setting and reduced-motion support.
6. **Click always works.** Drag is the nice way; click-to-act stays as the fallback for every action, for touch, keyboard and precision.

## Layout

The duel gets its own full-window screen: the site header hides, and the page doesn't scroll. Card size is computed from the window size so the whole table always fits.

Desktop, landscape:

```
┌──────────────────────────────────────────────┬──────────────┐
│ [Opp name · LP 8000]        opponent's hand (fanned backs)  │   Action log │
│  Extra  │  S/T  S/T  S/T  S/T  S/T  │  Deck                 │   (grouped by│
│  Field  │  Mon  Mon  Mon  Mon  Mon  │  GY  Banished         │    turn, with│
│ ─────── DP SP M1 BP M2 EP ─── [Battle] [End turn] ───────── │    Contest   │
│  GY Ban │  Mon  Mon  Mon  Mon  Mon  │  Field                │    buttons)  │
│  Deck   │  S/T  S/T  S/T  S/T  S/T  │  Extra                │              │
│ [Your name · LP 7200]         your hand (fanned, face up)   │  [settings]  │
└──────────────────────────────────────────────┴──────────────┘
```

- **Zone placement follows the real playmat:** Field Spell zone and Extra Deck on one side, GY, Banished and Deck on the other, mirrored for the opponent. Players coming from paper or other simulators find things where they expect.
- **The middle row** is one zone tall. On the left: whose turn it is, the phase stepper (DP, SP, M1, BP, M2, EP) with the current phase lit, and End turn. The next phase is clickable; that replaces the separate "Battle Phase" and "Main Phase 2" buttons. In the middle, the two shared Extra Monster Zones, above the second and fourth Main Monster Zones as on the real playmat, with the chain listed between them. Each shows whichever player's monster is in it, turned like the rest of that player's cards. On the right, what the duel waits for: an instruction, the judge's question, or whom it waits on. (Built 2026-11-19 with the Extra Monster Zones; before that a 52-pixel strip held the phases and the prompt replaced them.)
- **LP plates** sit at the corners next to each name. A change counts the number down over about half a second, flashes red for damage and green for gain, and shows the delta as a floating number.
- **Piles** (Deck, GY, Banished, Extra) show their top card and a count. Clicking one opens a pile viewer (see "Card details").
- **Right sidebar:** the action log, then a small settings button. Portrait screens put it below the board instead (see "Phones and tablets").
- **Background:** plain, with clearly drawn zone outlines so empty zones still read as places. Styling comes later (see Decisions).

## The hand

The hand should feel like holding cards.

- **Fanned arc.** Cards overlap and rotate slightly along an arc. Overlap grows as the hand gets bigger, so a 7-card hand still fits.
- **Hover lifts.** The hovered card rises, straightens and grows a little; its neighbours slide aside to show it fully. Springs, not fixed-time tweens, so moving the mouse across the hand ripples smoothly.
- **Reorder by dragging within the hand.** Other cards slide out of the way as you move (Motion `layout`). Arrow keys move a focused card. Hand order is a local preference, kept in the browser per duel, not sent to the server. New cards arrive at the right end.
- **Playable glow.** Cards with at least one legal action get a soft outline. Cards with none look normal; they aren't greyed out, so you can still read them.
- **The opponent's hand** is a fan of backs at the top. It animates when they draw, play or discard, and never when they reorder or hover (see "Hidden information").

## Drag and drop

Built with Motion alone. A hand card has one Motion drag for everything: while the pointer is along the hand it moves the card to the nearest slot (slots come from layout positions, so they don't shift under the moving cards), and above the hand the same drag becomes a drop. Motion's `Reorder` was tried first, as a gesture of its own beside the field drop, and reordering broke on your own turn. The zone under the pointer comes from the browser's `elementsFromPoint` and a `data-drop` key on every zone and LP plate. Aiming an attack doesn't move the card at all; it draws an SVG arrow from the attacker to the pointer. (dnd-kit was the plan, but with Motion already handling the drag it would have been a second drag system on the same cards.)

**Feel while dragging:**

- The card lifts (shadow grows, scales to about 1.1) and tilts toward the direction it's moving, then settles when you slow down.
- Legal drop zones light up as soon as the drag starts; the zone under the card brightens and slightly pulls the card toward its centre when near.
- Everything that isn't a legal target dims.
- Releasing over a legal zone plays the action. Releasing anywhere else springs the card back to where it came from. Nothing happens by accident.

**What you can drag:**

| Drag | Onto | Does |
| --- | --- | --- |
| Monster in hand | An empty Main Monster Zone | A small two-button choice at the drop point: **Summon** or **Set** (always asked; see Decisions). Needs tributes: the tribute choice starts with the eligible monsters glowing. |
| Spell/Trap in hand | An empty Spell/Trap Zone | Set (layer 1). From layer 2, the same small choice: **Activate** or **Set**. An activation is always asked, even when it is the only choice (while you hold priority after your own summon, a card can't be Set, and a drop meant as a Set must not activate it). |
| Field Spell in hand | Field Zone | Activate or Set |
| Monster on the field | An opponent's monster | Attack it. An arrow from the attacker follows the pointer during the drag. |
| Monster on the field | The opponent's LP plate | Direct attack, when legal |
| Card in hand | Your own hand | Reorder |

**Engine change this needs:** today the engine chooses the zone for a summon or Set. Dropping on a specific zone means `normalSummon`, `setMonster` and `setSpellTrap` intents (and their legal actions) take a zone, and the engine checks it's empty. Column choice matters later anyway, for Link arrows and column effects.

**Click, without dragging:** clicking a card opens a small action menu right next to it (the same choices as the sidebar buttons today). Choosing an action that needs a zone highlights the legal zones; clicking one finishes it. Attacks by click: choose **Attack**, then click the target.

## Choosing and targeting

One consistent pattern for every "pick some cards" moment: tributes, attack targets, discards, and from layer 2 effect targets and `ask_player` prompts.

- A short instruction appears on the right of the middle row ("Choose 1 monster to Tribute", with **Cancel**).
- Eligible cards glow and pulse gently; everything else dims.
- Clicking a card marks it with a numbered badge in the order chosen. When the count is reached the choice sends; for "choose up to N" a **Confirm** button appears.
- For targeting, an arrow (an SVG curve on an overlay above the board) runs from the source card to the pointer and snaps to a target when hovering one.
- Choices among cards in a pile (search your Deck, pick from a GY, banished cards or the Extra Deck) mark the pile with an outline and a "N to choose" badge. Opening it shows the pile's cards with the same marks, and the question with **Confirm** on top. When every option is in one pile, it opens by itself. Your Deck only opens for such a choice, and then shows only the cards you may pick.
- A question from the judge or a script (`ask_player`) is answered this way, never in a separate picker: the cards it offers glow where they are, on the field (an opponent's face-down card too), in your hand or in a pile, and the strip shows the question, how many are picked, **Clear** and **Confirm**. Choices that aren't cards ("Attack Position") are buttons in the strip. The duel waits for the answer, so there is no Cancel.

## Animation and feedback

**Where the animations come from.** Today the client gets only snapshots, so it can slide cards between zones but can't tell an attack from a direct move. Each pushed view will also carry the **public events since the last view**, rendered the same hidden-safe way as the log (`viewFor` already does this for log lines). The client plays them in order from a small animation queue, then settles on the final view. If the queue falls behind (a reconnect, or many events at once) it skips straight to the final view. Input is accepted as soon as the queue finishes.

**The set of animations (layer 1 events first):**

| Event | Animation |
| --- | --- |
| Turn starts | "Your turn" / "Opponent's turn" banner sweeps across the middle strip (about 0.8 s) |
| Phase changes | Stepper slides to the new phase |
| Draw | Card flies from Deck to hand, flipping face up on the way (face down for the opponent) |
| Normal Summon | Card travels to the zone, lands slightly oversized and settles, with a short ring of light from the zone |
| Set | Card slides in face down with a soft thud, no light |
| Flip Summon / flipped by attack | 3D flip on the Y axis |
| Position change | Rotates 90 degrees |
| Tribute | Card dissolves toward the GY with a glow, then the summon plays |
| Attack | Attacker lunges toward its target and back; small screen shake on impact |
| Battle damage | Floating red number over the player's LP plate; LP counts down |
| Destroyed | Card cracks and fades, then appears on top of the GY |
| Discard | Card drops from hand to GY |
| Duel ends | Full-board banner: Victory or Defeat, with the reason underneath |

Later layers add: activation (the card enlarges at the centre for a moment with its art, then returns), chain links stacking, effect resolution (a beam from the source card to what it affects), Synchro and Xyz summons, overlay units orbiting under an Xyz monster, ATK/DEF changes shown on the card in green or red.

**Implementation:** Motion for everything above. Only transforms and opacity are animated so the browser keeps it on the GPU. The queue speeds up when several events are waiting, so a burst of the opponent's actions plays quickly. A "fast" speed setting halves every duration; reduced motion (the system setting or a toggle) replaces movement with quick fades.

## Card details on hover

Card details move out of the sidebar into a **tooltip next to the card** (requested by Ethan, 2026-11-18).

- Appears after you rest on a card for about 250 ms, so sweeping across the board doesn't flash tooltips.
- Sits beside the card, on whichever side has room, and stays put rather than following the pointer.
- Shows the large image, name, type line, Level/Rank, ATK/DEF, and the full effect text in a readable font size. Long text scrolls inside the tooltip.
- From later layers it also shows what the plain card can't: current ATK/DEF against the printed values, counters, Xyz materials, lingering effects on it, and whether its once-per-turn effect was used this turn.
- **Hidden while dragging or choosing targets**, so it never covers what you're aiming at. It comes back once the choice is done.
- **Pin it** with right-click to keep it open and move the mouse into it (for scrolling long text). Esc or clicking elsewhere closes it.
- No tooltip for cards you can't see (face-down opponent cards, the opponent's hand).
- **Zoom with Shift** (like Tabletop Simulator's alt-zoom, requested by Ethan, 2026-11-19; Shift rather than Alt because Alt opens Firefox's menu bar, and Shift no longer pins): while Shift is held, the card under the pointer is shown as tall as the screen with its text beside it. It sits beside the card on the side with more room and shrinks to fit there, so it never covers the card you point at, and it follows the pointer from card to card. Releasing Shift (or leaving the window) closes it. It replaces the tooltip while shown, and works while dragging or choosing, since you asked for it.
- **Touch:** a long press pins it, as right-click does; tap elsewhere to close (see "Phones and tablets").

**Pile viewer:** clicking a GY, Banished or Extra Deck opens a sheet over the board with a grid of large cards, searchable by name. Hovering one shows the same tooltip.

## Chains and response windows (layer 4)

**The chain** appears in the middle of the board as a short stack of cards, offset like a fanned pile, each with a numbered badge (Chain Link 1, 2, 3, ...) and a faint line to the card that activated it. When the chain resolves, links resolve from the top: each one glows, plays its effect, and leaves the stack.

**Response windows** must look the same whether or not a player can respond, because the timing floor exists so the opponent learns nothing from how fast a window closes.

- **When you can respond:** a bar at the bottom says what just happened ("Opponent activated Rush Recklessly"), cards that can respond glow, and there is a **Pass** button. You respond by clicking or dragging the glowing card, like any other action.
- **When you can't:** the same bar appears briefly with "No responses" and passes by itself after the floor. You see it, but the opponent's screen is identical either way.
- **The opponent's screen** shows "Waiting for opponent" with the same look and duration however the other side decides.
- A thin progress line shows the floor running out. Passing early is allowed for you, but the server still holds the window to the floor, so it changes nothing the opponent sees.

**Auto-response settings:**

- **Per card:** in the tooltip's menu (and right-click on a card), "When this can respond: Ask me / Always activate / Never". The architecture already decides these defaults apply with the floor still in force. They are stored on the server with the duel seat, so they still work when your tab is in the background.
- **Global stops:** a small toggle near the phase stepper for "Auto-pass everything this turn", for when you know you have nothing.

## Action log and contesting rulings

The log moves to the sidebar and becomes structured, not a list of strings.

- **Grouped by turn**, with the turn number as a header; the current turn is expanded and earlier ones collapse.
- **Each entry is one player action** (an icon and a short sentence), and automated results nest underneath it, indented: the judge's ruling, cards moved, damage.
- **Hovering an entry** highlights the cards involved on the board, if they are still visible.
- **Rulings made by the judge** (layer 2 on) show a small flag button: **Contest**.

**Contest flow in the UI:**

1. Click **Contest** on a ruling. A small form opens under the entry with an optional sentence ("why do you think it's wrong?") and a submit button. It shows how many contests are left this match (the per-match cap).
2. The entry shows "Appeal running…" while the stronger model works. Play continues.
3. The result replaces the spinner: **Upheld** or **Overturned**, with the one or two sentence explanation, visible to both players.
4. If overturned, both players get a dialog: "Rewind to before this ruling? This undoes N actions." with a preview of the board as it would be. Both must accept (layer 6). If either declines, play continues and the outcome is still stored as a candidate ruling.

**Engine change this needs:** log entries become objects instead of strings: an id, the acting player, a kind, the visible card ids involved, the nested results, and, for judge decisions, the decision id and whether it can be contested. The hidden-information rule stays the same: entries are rendered per player by `viewFor`.

Later (build step 7): clicking an old entry shows the board as it was then (read-only), since the event log makes that a replay. Full replays build on the same thing.

## Phones and tablets

Built 2026-11-19, after Ethan's phone showed the board cut off beside the log. One board for every screen; only where things sit changes (`useBoardSize` in `look.ts` decides, `board.css` lays it out).

- **Portrait screens** (phones, tablets held upright) stack: the board across the full width, then a bar with the turn controls and what the duel waits for, then the log and chat. Zones are sized from the width, so on a 390-pixel phone a zone is about 50 pixels. The board takes at most 62% of the screen's height, leaving the rest to the log.
- **Small zones** (under 110 pixels, as on a landscape phone or a 720-pixel laptop) keep the log beside the board, but the turn controls and prompts leave the middle row for a bar above the log, where they have room.
- **Tight zones** (under 80 pixels) shrink the Life Points plates to a zone's width, showing just the number (the name is its tooltip), so they clear the hand.
- **Playing by touch** needs no new controls: every action already works by tap. Tap a card for its menu, pick the action, then tap the lit zone or target. Dragging a hand card to a zone and dragging an attacker's arrow to a target also work with a finger (the table takes every touch, so the page never scrolls or zooms under a drag).
- **Card details:** a long press (450 ms without moving) pins the same tooltip a right-click does, while choosing or dragging too, as Shift zoom does. Tapping elsewhere closes it. Hover tooltips and the hand's hover lift are mouse-only, since a tap would only flash them.

## Card images

- **Two sizes are already stored** (small, about 168 px wide, and full, about 420 px). Board cards pick between them with `srcset` based on their on-screen size and pixel density, so a large monitor or a phone's sharp screen gets the full image. Tooltips and the pile viewer always use the full image.
- **Preload your own deck** when the duel opens, so no card pops in blank mid-duel. A short loading screen covers it on a slow connection. The opponent's cards load as they are revealed, because preloading them would tell your browser their decklist.
- **Cropped artwork** (just the art, no frame) is useful for activation and summon close-ups. YGOPRODeck serves these too; the importer would download them alongside the other two sizes, under the same terms (store locally, re-host, rate limit).
- **Card back and playmat:** our own designs, not the official card back. One standard layout for now (see Decisions).

## Hidden information

The UI can leak what the server so carefully hides. Rules:

- Nothing about the opponent's hand moves unless a public event happened: no hover lift, no reorder, no drag preview, no "considering" highlight.
- The Set animation is identical for Spells, Traps and monsters of any kind; durations never depend on a hidden card.
- Response windows look and last the same whether or not anyone could respond (see above).
- Animations are driven only by the public events in each player's view, never by data sent to the other player.
- Opponent's face-down cards and hand get no tooltip and no hover effect beyond a plain highlight.

## Accessibility and settings

- Keyboard: Tab through your hand and field, Enter opens a card's action menu, arrow keys move between zones while choosing, Esc cancels. Keyboard players use the click flow, which can do everything a drag can: Enter opens a card's menu, choosing an action lights the legal zones, Tab and Enter pick one.
- Every card and zone has an accessible label ("Your Main Monster Zone 3, Tenshin, Attack position").
- Highlights use shape as well as colour (outline style, badges), so they work for colour-blind players.
- Settings panel: animation speed (normal, fast), reduced motion, sound mute and volume (once there are sounds), auto-pass defaults.

## Frontend structure

- **Libraries:** Motion (already installed) for springs, layout, hand fan, dragging and all animations; plain SVG for arrows and the chain lines. No canvas or PixiJS: nothing here needs it, and DOM keeps text, tooltips and accessibility easy. A tooltip positioning library (Floating UI) is worth adding for the hover cards, since placing a tooltip on the side with room and keeping it on screen is what it's for.
- **Interaction state** (selected card, what's being chosen, dragged card, pinned tooltip) moves from the separate `useState` calls in `Board.tsx` to one reducer, since the number of modes grows with every layer.
- **Components:** split `Board.tsx` into table layout, `Hand`, `Zone`, `Pile`, `PhaseStepper`, `LpPlate`, `CardTooltip`, `ActionMenu`, `ChoicePrompt`, `Log`, and the animation queue hook. Each piece stays small.

## Build order

PC first (see Decisions). Each step ends with a board two people can play on, and each sits on top of a working one. Steps 1 and 2 need nothing from the engine beyond small view changes; the rest arrive with the engine layer that makes them meaningful.

1. **Table and feel (on today's layer-1 engine).** Full-window duel screen that fits without scrolling, playmat zone layout (plain styling), phase stepper, LP plates with counting and floating damage numbers, fanned hand with hover lift and reorder, playable glow, action menu next to the clicked card, hover tooltips replacing the sidebar card, pile viewer, `srcset` and image preloading, structured turn-grouped log in the sidebar. Server sends public events with each view; the animation queue plays draw, summon, Set, flip, position change, tribute, attack, damage, destroy, turn banner and duel end. Reduced motion and speed setting.
   - Done when: a full duel plays with no sidebar buttons and every change is animated.
   - Built 2026-11-19. Notes from building it: Floating UI places the tooltip and the action menu, and Motion's newer `Reorder.Board` (dragging items between groups) was checked for step 2 and isn't needed (see Drag and drop). Only your own deck's images are preloaded: preloading the opponent's would reveal their decklist once custom decks exist. The queue plays bursts faster. Sound is not wired in yet: with no assets it would be code with nothing to play, so it comes with step 7.
2. **Drag and drop.** The zone parameter on summon and Set intents, drag to summon/Set, drag to attack with the arrow, the shared choosing pattern for tributes and discards.
   - Done when: every layer-1 action can be done by dragging on a PC.
   - Built 2026-11-19. Dropping a Tribute Summon onto one of your own monsters picks that monster as a tribute, since its zone is where the new one goes. Clicking still does everything: choosing Normal Summon, Set or Attack from a card's menu lights up the legal zones or targets. A card dropped on a zone stays over it, centred and a little enlarged, while you choose Summon or Set or its tributes, and until the server's step moves it in; then the same element glides into the slot (Motion `layoutId`) and a Set card turns face-down and sideways as it lands. Cards stay one continuous element wherever they can rather than vanishing and reappearing.
3. **Effects (with engine layer 2).** Activate from the action menu or by dragging, targeting arrows, the card picker sheet for `ask_player`, activation and resolution animations, judge rulings in the log with the Contest button and appeal result.
   - Built 2026-11-19 on the API in [effects.md](effects.md). A Spell or Trap dropped on a Spell & Trap Zone asks Activate or Set; other effects are activated from the card's menu. While the judge works, the phase strip says what it is doing and the board takes no actions; an activated card from the hand waits over its zone until the ruling. A question from the judge is answered on the board, as in Choosing and targeting (changed 2026-11-19; it used to open a separate picker sheet). Effects waiting to resolve point at their targets with dashed gold arrows. Rulings stand out in the log with a Contest button (once per ruling), and the appeal's verdict follows them. Changed ATK/DEF shows as a badge on the monster's zone, green when raised and red when lowered. LP changes from effects float up like battle damage, green for gains.
4. **Extra Deck (with engine layer 3).** Synchro and Xyz from the Extra Deck pile: choose materials with the choosing pattern, summon animations, overlay units shown under Xyz monsters. Synchro built 2026-11-19: the Extra Deck pile glows when one of its monsters can be Summoned; in the opened pile that card glows, and clicking it offers Synchro Summon in Attack or Defense Position. The materials are then picked on the field (only monsters that complete some legal set glow), and the zone after them when more than one is open, the Extra Monster Zones included. Xyz Summons work the same way. An Xyz Monster's materials sit tucked under it, edges showing, with a gold count in its corner; when the judge or a script asks the player to pick materials, they fan out to its left so each can be clicked.
5. **Chains and responses (with engine layer 4).** Chain stack, response bar, the floor's progress line, per-card auto-response settings and global auto-pass, and the turn timer.
6. **Lingering effects and rollback (with engine layers 5 and 6).** Modified ATK/DEF on cards, restriction and counter badges, the details in tooltips, the rollback consent dialog with board preview.
7. **Polish.** Sound effects once there are assets, visual styling, clicking old log entries to view past boards.
8. **Phones.** The portrait layout and touch drag described under "Phones and tablets".
9. **Later ideas.** Full replays, custom playmats.

## Decisions

Ethan answered the open questions on 2026-11-18.

| Question | Decision |
| --- | --- |
| Flat or tilted table | Flat, with depth from shadows |
| Overall look | Function first: everything should feel good and the whole board should fit the window without scrolling, horizontally or vertically. Styling (playmat, themes) comes after. |
| Sound | Plumb in sound effects with a mute button and volume slider, quiet by default. No assets yet, so sounds are added when there are some. |
| Animation speed | The opponent's actions often arrive in a burst (for example right after they end a turn), so the queue plays faster the more events are waiting. One base speed for both players. |
| Turn timer | Wanted. It belongs with the response-window timing work (engine layer 4), so it is built there. |
| Dropping a monster on a zone | Always ask Summon or Set. A setting or hotkeys may come later. |
| Phones | PC first. Phones come after the PC board is done, since a good board is hard to fit on a phone. |
| Card back and playmat | One standard layout for now. Later, maybe let players upload their own playmat (with a template to line it up in an image editor) or make one on the site. |
| Past boards from the log | Yes, it's cheap with the event log. Keep the log detailed enough that full replays can be added later too. |
