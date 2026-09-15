import { FamilyFlow } from './features/family/FamilyFlow';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { DemoFlowRoute } from './features/demo/DemoFlow';
import { DemoStart } from './features/demo/DemoStart';
import { demoStepPath } from './features/demo/steps';
import { ResearchFlow } from './features/research/ResearchFlow';

function DemoEntryRedirect() {
  const { scenarioId = '' } = useParams();
  return <Navigate to={demoStepPath(scenarioId, 'question')} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/family" element={<FamilyFlow />} />
      <Route path="/research" element={<ResearchFlow />} />
      <Route path="/research/:answerRunId" element={<ResearchFlow />} />
      <Route path="/" element={<DemoStart />} />
      <Route path="/demo/:scenarioId" element={<DemoEntryRedirect />} />
      <Route path="/demo/:scenarioId/:step" element={<DemoFlowRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
