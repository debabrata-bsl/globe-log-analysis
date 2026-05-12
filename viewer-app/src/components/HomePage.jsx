import { useNavigate } from "react-router-dom";
import {
  MdCalendarToday,
  MdPersonSearch,
  MdArrowForward,
} from "react-icons/md";
import "../styles/HomePage.css";

const CARDS = [
  {
    id: "daily",
    route: "/daily",
    label: "Daily View",
    badgeClass: "badge-blue",
    iconClass: "icon-blue",
    ctaClass: "cta-blue",
    arrowClass: "arrow-blue",
    icon: <MdCalendarToday />,
    title: "Error Log Based on Daily",
    desc: "View and filter error reports grouped by day.",
  },
  {
    id: "msisdn",
    route: "/msisdn",
    label: "User Lookup",
    badgeClass: "badge-violet",
    iconClass: "icon-violet",
    ctaClass: "cta-violet",
    arrowClass: "arrow-violet",
    icon: <MdPersonSearch />,
    title: "Error Log Based on MSISDN",
    desc: "View for a specific user's error history by their MSISDN number. ",
  },
];



export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="home-page">

      {/* Fixed top header */}
      <div className="home-header">
        <div>
          <h1 className="home-header-title">Log Analytics Dashboard</h1>
          <p className="home-header-sub">Select a module to analyze your eKYC service logs</p>
        </div>
      </div>

      {/* Cards area */}
      <div className="home-main">
        <section className="home-hero">
          <span className="home-hero-chip">EKYC Log Analyzer</span>
          <h2 className="home-hero-title">Analyze failures faster with focused views</h2>
        </section>
        <div className="cards-grid">
          {CARDS.map((c) => (
            <div
              key={c.id}
              className="dash-card"
              onClick={() => navigate(c.route)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && navigate(c.route)}
            >
              <div className="card-header-row">
                <div className={`card-icon ${c.iconClass}`}>{c.icon}</div>
                <span className={`card-badge ${c.badgeClass}`}>{c.label}</span>
              </div>

              <div className="card-body">
                <h3>{c.title}</h3>
                <p>{c.desc}</p>
              </div>

              <div className="card-divider" />

              <button type="button" tabIndex={-1} className={`card-cta ${c.ctaClass}`}>
                <span>Open Module</span>
                <div className={`cta-arrow-wrapper ${c.arrowClass}`}>
                  <MdArrowForward />
                </div>
              </button>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
