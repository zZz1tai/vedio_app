import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { WebOnlyColorSchemeUpdater } from './ColorSchemeUpdater';
import { WebOnlyPrettyScrollbar } from './PrettyScrollbar'
import { HeroUINativeProvider } from '@/heroui';

function Provider({ children }: { children: ReactNode }) {
  return <ThemeProvider>
    <WebOnlyColorSchemeUpdater>
      <WebOnlyPrettyScrollbar>
        <AuthProvider>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <HeroUINativeProvider>
              {children}
            </HeroUINativeProvider>
          </GestureHandlerRootView>
        </AuthProvider>
      </WebOnlyPrettyScrollbar>
    </WebOnlyColorSchemeUpdater>
  </ThemeProvider>
}

export {
  Provider,
}
