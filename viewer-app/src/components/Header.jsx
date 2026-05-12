import { useNavigate } from "react-router-dom";
import { MdArrowBack } from "react-icons/md";
import "../styles/Header.css";

export default function Header({ title }) {
  const navigate = useNavigate();

  return (
    <header className="app-header no-print">
      <div className="header-left">
        <button className="back-btn" onClick={() => navigate("/")}>
          <MdArrowBack size={20} /> Back
        </button>
      </div>
      <div className="header-center">
        <h1>{title}</h1>
      </div>
      <div className="header-right" />
    </header>
  );
}
