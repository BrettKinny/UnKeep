# Sharing into UnKeep from the iOS share sheet

iOS Safari does not support the Web Share Target API, so an installed UnKeep
PWA cannot appear in the share sheet by itself. The workaround is a small
Shortcut that forwards shared text to UnKeep's `/share` page.

The shared content travels in the URL **fragment** (`#...`), which browsers
never send to the server. It remains local to the browser path, subject to the
history and local-storage retention caveats below, until UnKeep saves it into
the encrypted vault.

> On Android/Chrome no shortcut is needed: the installed PWA registers itself
> in the system share sheet via the manifest's `share_target`. Android POSTs
> the content to the installed app's service worker, which converts it to a
> local fragment during the normal active-worker path. If the service worker is
> unavailable, the relay rejects the fallback instead of rendering or storing
> it, but the plaintext POST has already crossed the reverse-proxy and relay
> boundary. Use this fragment-based Shortcut pattern instead when that fallback
> exposure is outside your threat model.

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
2. Safari opens UnKeep's `/share` page and shows a local preview.
3. Confirm the preview. Once the selected vault is unlocked, the note is saved
   durably and synced like any other.

If you weren't signed in when you shared, the content waits in local storage
after confirmation. UnKeep asks before assigning an unbound share to whichever
vault you unlock, and sharing while offline still works.

## Notes and limitations

- The shortcut opens Safari (or your default browser), not the standalone
  home-screen app window. Treat that browser and the installed PWA as separate
  UnKeep devices: pair or unlock the browser profile before saving there. Once
  both contexts are paired to the same relay vault, encrypted sync delivers
  the saved note to the installed app.
- The fragment is not sent in the HTTP request, and UnKeep replaces the URL as
  soon as its share page mounts. It can still be retained briefly by browser
  history, URL synchronization, crash reporting, or the Shortcut itself.
  After confirmation, a share waiting for a vault is plaintext in that browser
  profile's local storage until UnKeep saves and removes it.
- Very large shares can exceed URL length limits; the shortcut is intended
  for text snippets, links, and paragraphs, not documents.
- You can also pass structured params in the fragment:
  `/share#title=Groceries&text=milk%20and%20eggs`.
