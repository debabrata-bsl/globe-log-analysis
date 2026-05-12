import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import HomePage from "./components/HomePage";
import ErrorReport from "./components/ErrorReport";
import Header from "./components/Header";
import "./App.css";

function Layout({ children, title, modalOpen = false }) {
  return (
    <div className={`app-root with-header${modalOpen ? " blur-background" : ""}`}>
      <Header title={title} />
      {children}
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        
        <Route path="/daily" element={
          <Layout title="Daily Error Analysis">
            <ErrorReport />
          </Layout>
        } />

        <Route path="/msisdn" element={
          <Layout title="Error Log Based on MSISDN">
            <ErrorReport
              enableFailureAnalysis={false}
              enableMsisdnFilterUpload={true}
              errorsOnly={true}
              compactTable={true}
              reportCsvName="my_msisdn_error_report.csv"
            />
          </Layout>
        } />
      </Routes>
    </Router>
  );
}
