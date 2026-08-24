import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Uniwind } from 'uniwind';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'app.theme.preference';
const VALID_PREFERENCES: ThemePreference[] = ['system', 'light', 'dark'];

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: 'system',
  setPreference: () => undefined,
});

function ThemeProvider({ children }: { children?: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('dark');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (
          stored === 'system' ||
          stored === 'light' ||
          stored === 'dark'
        ) {
          setPreferenceState(stored);
        }
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    Uniwind.setTheme(preference);
    AsyncStorage.setItem(STORAGE_KEY, preference).catch(() => undefined);
  }, [loaded, preference]);

  const setPreference = useCallback((value: ThemePreference) => {
    setPreferenceState(value);
  }, []);

  const value = useMemo(
    () => ({ preference, setPreference }),
    [preference, setPreference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemePreference() {
  return useContext(ThemeContext);
}

export { ThemeProvider, useThemePreference };
