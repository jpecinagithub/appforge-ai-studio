/**
 * Frontend contract lint — unit tests (agent's guardrails, 2026-10-21).
 * Reproduces the T-shirts run 977a3ab8 violation: a hand-written
 * fetch('/api/shirts') in App.tsx that escaped the /a/<projectId>/
 * prefix, 404'd against the platform's own API and crashed the page
 * rendering undefined data.
 */
import { describe, expect, it } from 'vitest';
import {
  frontendContractViolations,
  frontendContractsNote,
  isApiClientFile,
} from './frontendContracts.js';

const TSHIRTS_APP = `import { useEffect, useState } from 'react';
export default function App() {
  const [shirts, setShirts] = useState([]);
  useEffect(() => {
    (async () => {
      const response = await fetch('/api/shirts');
      const data = await response.json();
      setShirts(data.items);
    })();
  }, []);
  return null;
}
`;

describe('frontendContractViolations', () => {
  it('flags the T-shirts case: fetch with a hand-written absolute /api path in App.tsx', () => {
    const v = frontendContractViolations([{ path: 'src/App.tsx', content: TSHIRTS_APP }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('src/App.tsx');
    expect(v[0]).toContain("fetch('/api/shirts')");
    expect(v[0]).toContain('/a/<projectId>/');
    expect(v[0]).toContain('frontend/src/api.ts');
  });

  it('flags double-quoted, template-literal and axios spellings', () => {
    const cases = [
      'await fetch("/api/cart");',
      'await fetch(`/api/shirts/${id}`);',
      "await axios.get('/api/orders');",
      'await axios.post("/api/orders", body);',
      "await axios('/api/orders');",
    ];
    for (const content of cases) {
      expect(frontendContractViolations([{ path: 'src/App.tsx', content }]), content).toHaveLength(1);
    }
  });

  it('reports one violation per file even with several bad calls', () => {
    const v = frontendContractViolations([
      { path: 'src/App.tsx', content: "fetch('/api/a'); fetch('/api/b');" },
      { path: 'src/pages/Cart.tsx', content: "axios.get('/api/cart');" },
    ]);
    expect(v).toHaveLength(2);
    expect(v[0]).toContain('src/App.tsx');
    expect(v[1]).toContain('src/pages/Cart.tsx');
  });

  it('never judges the API client itself, whatever it contains', () => {
    expect(isApiClientFile('src/api.ts')).toBe(true);
    expect(isApiClientFile('src/api-url.ts')).toBe(true);
    expect(isApiClientFile('src/App.tsx')).toBe(false);
    const client = "export const login = () => fetch('/api/auth/login');";
    expect(frontendContractViolations([{ path: 'src/api.ts', content: client }])).toEqual([]);
    expect(frontendContractViolations([{ path: 'src/api-url.ts', content: client }])).toEqual([]);
  });

  it('stays silent on the supported patterns', () => {
    const clean = [
      // The client's own pattern, used by hand: the literal is wrapped by
      // resolveApiUrl, not handed to fetch directly.
      "const res = await fetch(resolveApiUrl('/api/shirts', document.baseURI));",
      // Relative URLs stay below the prefix by construction.
      "await fetch('./api/shirts');",
      "await fetch('api/shirts');",
      // External absolute URLs are not the app's API.
      "await fetch('https://api.openverse.org/v1/images/?q=cat');",
      "await axios.get('https://example.com/api/things');",
      // Variables and the client object itself.
      'await fetch(url);',
      'const shirts = await api.listShirts();',
      '',
    ];
    for (const content of clean) {
      expect(frontendContractViolations([{ path: 'src/App.tsx', content }]), content).toEqual([]);
    }
    expect(frontendContractsNote([{ path: 'src/App.tsx', content: 'export const ok = 1;' }])).toBeNull();
    expect(frontendContractsNote([{ path: 'src/App.tsx', content: TSHIRTS_APP }])).toContain('Frontend contract check');
  });
});
