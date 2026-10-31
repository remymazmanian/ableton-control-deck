import dashboardPackage from "../package.json";

export function SiteFooter() {
  return (
    <footer className="deck-credit">
      <p>
        Ableton Control Deck v{dashboardPackage.version} · Built by Remy Mazmanian ·{" "}
        <a href="https://remymazmanian.com/ableton-control-deck/" target="_blank" rel="noopener noreferrer">
          remymazmanian.com
        </a>
      </p>
    </footer>
  );
}
