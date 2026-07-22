# Sharing into UnKeep from the iOS share sheet

iOS Safari does not support the Web Share Target API, so an installed UnKeep
PWA cannot appear in the share sheet by itself. The workaround is a small
Shortcut that forwards shared text to UnKeep's `/share` page.

The shared content travels in the URL **fragment** (`#...`), which browsers
never send to the server — so, like Quick Send, the text stays on your device
until it lands encrypted in your vault.

> On Android/Chrome no shortcut is needed: the installed PWA registers itself
> in the system share sheet via the manifest's `share_target`. Note that the
> Android path delivers content as query parameters, which are part of the
> request to your own UnKeep server (they are not logged by it, and never
> reach any third party).

## Create the Shortcut

1. Open the **Shortcuts** app and tap **+** to create a new shortcut.
2. Name it **Save to UnKeep** (this is the name that appears in the share sheet).
3. Tap the info panel (ⓘ) → enable **Show in Share Sheet**. Under
   **Share Sheet Types**, select **Text** and **URLs**.
4. Add the action **URL Encode** (search for "URL Encode"). Set its input to
   **Shortcut Input**.
5. Add the action **Open URLs** with:

   ```
   https://YOUR-UNKEEP-HOST/share#[URL Encoded Text]
   ```

   where `[URL Encoded Text]` is the magic variable produced by step 4, and
   `YOUR-UNKEEP-HOST` is your UnKeep server's address.

## Use it

1. In any app, share some text or a page and pick **Save to UnKeep**.
2. Safari opens UnKeep's `/share` page, which stashes the content locally and
   redirects to the app.
3. Once your vault is unlocked, the note is created and synced like any other.

If you weren't signed in when you shared, the content waits in local storage
and is saved as soon as the vault unlocks — sharing while offline works too.

## Notes and limitations

- The shortcut opens Safari (or your default browser), not the standalone
  home-screen app window. Modern iOS shares site storage between Safari and
  the installed PWA for the same origin, so notes land in the same vault; on
  older iOS versions the home-screen app has separate storage — if saved notes
  don't appear in the installed app, sync from the server will still deliver
  them once both contexts are signed in.
- Very large shares can exceed URL length limits; the shortcut is intended
  for text snippets, links, and paragraphs, not documents.
- You can also pass structured params in the fragment:
  `/share#title=Groceries&text=milk%20and%20eggs`.
