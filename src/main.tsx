import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { ExplorePage } from './features/explorer/ExplorePage';
import { DataPage } from './features/data/DataPage';
import { SourcesPage } from './features/sources/SourcesPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id/explore" element={<ExplorePage />} />
        <Route path="/projects/:id/data" element={<DataPage />} />
        <Route path="/projects/:id/sources" element={<SourcesPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
