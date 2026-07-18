export const VERSION = '0.1.0';

export const HELP = `Usage: unkeep [connection options] <command> [options]

Commands:
  login                 Pair this terminal with an existing UnKeep device
  list                  List notes
  get <id>              Print a note's content
  put <id> [content]    Create or update a note (reads content from stdin when omitted)
  sync                   Pull remote changes into local CLI state
  clip <file>            Encrypt and upload a file to the clipboard
  paste [id]             Download the latest clip (or a specific attachment ID)

Connection options (flags override environment and config file):
  --endpoint <url>       Relay URL (UNKEEP_ENDPOINT)
  --credential <token>  Device credential (UNKEEP_CREDENTIAL)
  --vault-key <key>      Base64/base64url/hex vault key (UNKEEP_VAULT_KEY)
  --config-dir <path>    Override the standard UnKeep config directory

Output options:
  --json                 Emit stable JSON on stdout
  -h, --help             Show help
  --version              Show version

List options:
  --label <label>        Require a label (repeatable)
  --archived[=true|false]
  -q, --search <text>    Search title, content, and labels

Put options:
  --id <id>              Note ID (alternative to the positional ID)
  --content <text>       Note body
  --title <title>        Note title
  --label <label>        Set labels (repeatable; comma-separated values accepted)
  --archived[=true|false]
  --pinned[=true|false]

Clipboard options:
  clip --list            List clips, newest first
  paste --force          Replace an existing file with the same name
`;
