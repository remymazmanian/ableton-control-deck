const version = process.env.CONTROL_DECK_VERSION;
if (!version) throw new Error("CONTROL_DECK_VERSION is missing. next.config.ts reads it from the root package.json.");

export function SiteFooter() {
  return (
    <footer className="deck-credit">
      <p>
        Ableton Control Deck v{version} · Built by Remy Mazmanian ·{" "}
        <a href="https://remymazmanian.com/ableton-control-deck/" target="_blank" rel="noopener noreferrer">
          remymazmanian.com
        </a>
      </p>
    </footer>
  );
}
