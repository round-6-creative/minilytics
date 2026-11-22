import { createContext, useContext } from 'react';
import type { Query, Site } from './api';

export interface Dash {
  /** Where this dashboard's data comes from: /api/sites/<id>, or /api/share/<token> for a shared link. */
  base: string;
  /** A shared link: totals only, nothing can be changed and no visitor is shown. */
  readonly: boolean;
  site: Site;
  q: Query;
  reloadKey: number;
  decimals: number;
  money: (minor: number, compact?: boolean) => string;
  addFilter: (key: string, value: string) => void;
  openVisitor: (visitorId: string) => void;
}

export const DashContext = createContext<Dash | null>(null);

export function useDash(): Dash {
  const d = useContext(DashContext);
  if (!d) throw new Error('useDash outside dashboard');
  return d;
}
