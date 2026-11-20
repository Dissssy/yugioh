# Keyboard controls

Status, 2026-11-20: built, with the recommended answers to the decisions below (Ethan asked for it right after replays). Notes marked **Built** say where the code differs from the plan. The design doesn't depend on the layout, so later layout changes won't break it. Part of the order in [next-steps.md](next-steps.md).

The goal is a whole duel with no mouse: playing cards, choices and targets, chains, piles, the log, chat, contesting and asking the judge.

## What exists today

- A hand card takes focus; Enter opens its menu, and Left and Right move it along the hand.
- A zone or pile that is part of a choice answers Enter.
- Esc closes the action menu, the pile viewer and the tooltip.
- Holding Shift zooms the card under the pointer; right-click pins its details ([duel-ui.md](duel-ui.md)).

Everything else needs the pointer, and there is no way to move focus across the field.

## Principles

- **The keyboard drives the click flow.** Every mouse action already has a click path (duel-ui principle 6: "Click always works"). Keyboard control is that same path with a focus instead of a pointer: Enter does what a click does, Esc does what clicking away does. No action gets a keyboard-only path.
- **Arrows move by what's on screen.** Up, Down, Left and Right move focus to the nearest focusable element in that direction, measured from the elements' boxes on screen. That works the same in the landscape, portrait and small-zone layouts, and keeps working when the layout changes, with no grid table to keep in step.
- **One visible focus.** In keyboard mode the focused element has a clear ring of its own, distinct from the playable glow and the pick badges. The ring hides as soon as the mouse is used (`:focus-visible`).
- **Plain keys.** No Alt (it opens Firefox's menu bar). Shift stays zoom. No Ctrl or Cmd combinations, which belong to the browser and the OS (Ctrl+arrows switches desktops on a Mac). Letter shortcuts work only when focus isn't in a text field.
- **One key table.** Every shortcut lives in one table (`web/src/board/keys.ts`) that both handles the keys and draws the help overlay, so the help can't drift from what the keys do.

## Focus areas

The duel screen has four areas: the **board** (both fields, both hands, the Extra Monster Zones, piles and LP plates), the **strip** (phase stepper, prompt and its buttons), the **log** and the **chat**. Tab and Shift+Tab move between areas; each area remembers its focused element, and arrows move inside it (the WAI-ARIA "roving tabindex" pattern). So Tab never walks through forty cards one by one.

Shift+Tab is a Shift press too. Zoom opens only when Shift is held alone for about 150 ms, so Shift+Tab doesn't flash a zoom.

## Keys

**On the board**

| Key | Does |
| --- | --- |
| Arrows | Move focus to the nearest card, zone, pile or LP plate in that direction |
| Enter or Space | What a click does: open the card's action menu, open a pile, pick or unpick during a choice |
| Esc | Back one level: close a menu or pile, cancel a cancellable choice, unpin details |
| I | Pin the focused card's details, as right-click does |
| Shift (hold) | Zoom the focused card (the card under the pointer wins while the mouse is in use) |

**In a menu** (a card's actions, Summon or Set, Activate or Set, a position)

| Key | Does |
| --- | --- |
| Up, Down | Move through the items |
| Enter or Right | Choose the item, or open its submenu |
| Left or Esc | Back to the menu above, or close |
| 1 to 9 | Choose that item directly |

**While choosing** (tributes, materials, targets, a judge question)

- Arrows move only between cards that may be picked, and the pile that holds pickable cards. Enter on such a pile opens it with the same marks.
- Enter or Space picks and unpicks; **C** confirms when Confirm is shown; Esc cancels when the choice can be cancelled.
- After choosing a summon or Set, arrows move only between the lit zones, and Enter puts the card there.
- **Aiming an attack:** choosing Attack puts focus on the first legal target, the opponent's LP plate included for a direct attack. Arrows move between targets; Enter attacks.

**Anywhere outside a text field**

| Key | Does |
| --- | --- |
| P | Pass, or Don't activate for an optional trigger |
| N | Go to the next phase (the lit one in the stepper) |
| E | End turn |
| L | Focus the log, on its newest entry |
| T | Focus the chat box |
| Q | Focus the chat box in Ask the judge mode ([ask-the-judge.md](ask-the-judge.md)) |
| ? | Show the keys |

**In the log:** Up and Down move between entries; Enter on a ruling opens its Contest form, and on an answer from the judge its Escalate. Esc goes back to the board.

**In the chat box:** Enter sends; Esc goes back to the board.

**In the pile viewer:** arrows move through its grid, typing goes to its search box, Enter acts as a click, Esc closes it.

**Rock-paper-scissors, going first, rollback offers:** their buttons are in the strip, so Tab and Enter reach them; they need no keys of their own.

**Built:**
- The code is `web/src/board/nav.ts` (`useKeyboardNav`, `nearest`) and `web/src/board/keys.tsx` (the key table `KEYS` and the help overlay). One window keydown listener moves focus; Board runs the letter shortcuts from the same table.
- Board items carry `data-nav` (a card's zone key, a hand card's ID, a pile's key) and, while a choice is open, `data-pick` on what may be picked; the arrows keep to `data-pick` then. An empty zone is focusable only while a card may go there. LP plates aren't focusable: a direct attack happens at once from the menu.
- The strip area is the phase strip, the compact bar, the rock-paper-scissors and going-first panel and the result screen. The chat area is the chat box, or the replay controls on a replay page; there Up and Down leave the text box or seek bar, Left and Right stay in it.
- **C** confirms an answer to the judge (not in the plan's list).
- Menus stay flat (Synchro and Xyz Summons already list one item per position), so they need no nested menus: Up, Down, 1 to 9, Right to choose, Left or Esc to close and go back to the card. Items are numbered when there are several. **Move in hand** shows only when the menu was opened by keyboard.
- When a choice starts from the keyboard, focus goes to its first option (the first lit zone, the first attack target, the first tribute).
- Shift zooms the focused card when the keyboard was used last, and only after Shift is held alone for 150 ms.

## Design

- **`useKeyboardNav`** (a hook in `web/src/board/`) holds whether the player is in keyboard mode, the focused element per area, and the arrow handling. Every focusable board element gets a `data-nav` key: the existing drop key (`dropKey`) where there is one, the card's instance ID otherwise. `nearest(from, direction, candidates)` picks the element whose box is closest in that direction, preferring ones that overlap the current one's row or column. Candidates depend on the board's mode: everything, the pickable cards, the lit zones, or the attack targets. That mode is already in the board's `mode` reducer, so the hook reads it rather than keeping its own.
- **Menus with submenus.** The action menu and the follow-up popovers (Summon or Set, Attack or Defense Position after Synchro Summon) become one nested menu. `@floating-ui/react` is already a dependency and provides `useListNavigation` (arrow keys), `useTypeahead` and `FloatingTree` (nested menus that close together), so menus need no new library and the mouse gets the same nesting.
- **Moving a hand card:** Left and Right now move focus, so reordering moves into the card's menu: **Move** puts the card in a move state where Left and Right shift it and Enter or Esc ends the move. Dragging is unchanged.
- **Zoom on focus:** `CardTooltip`'s Shift handling uses the focused card when the last input was the keyboard.
- **Labels:** every zone and card gets the accessible label duel-ui.md planned ("Your Main Monster Zone 3, Tenshin, Attack Position"), which also helps screen readers.

## Testing

A Playwright script plays a whole duel by keyboard alone against an AI test seat with the random fake model (as in `server/test/opponent.test.ts`), run locally as in the local browser testing notes. It catches any action the keyboard can't reach.

**Built:** checked by hand on 2026-11-20 with a Playwright script against a second browser playing the other seat: rock-paper-scissors and going first through the strip, a Normal Summon from the hand menu into a zone picked with the arrows, declining a trigger and passing a window with P, the Battle Phase with N, a direct attack and an attack on a chosen target, the help overlay, the log, and ending the turn with E. The web app has no test runner yet, so the script isn't in the repository.

## Decisions for Ethan

Built with the recommendations; any of them is easy to change.

| Question | Recommendation | Other options |
| --- | --- | --- |
| Shortcut letters for the strip (P, N, E, L, T, Q) | Yes | Only Tab to the strip and Enter on its buttons |
| Guard on End turn | None, like the button today | Press E twice within a second |
| Arrows while choosing | Only the cards and zones you may pick | Move anywhere, and Enter on an ineligible card does nothing |
| Rebinding keys | Not now; the one key table makes an account setting easy later | A settings page with rebinding from the start |
| Reordering the hand by keyboard | Move item in the card's menu | A modifier with the arrows (but Alt and Ctrl are out) |
