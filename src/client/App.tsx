import { Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { BoardPage } from './pages/BoardPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/b/:boardId" element={<BoardPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  );
}
