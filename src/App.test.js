import { render, screen } from '@testing-library/react';
import App from './App';

test('renders the login screen when no user is stored', () => {
  sessionStorage.clear();
  render(<App />);
  expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument();
});
