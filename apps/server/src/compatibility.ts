export type CompatibilityLanguage = 'es' | 'en';

interface TechnologyRule {
  label: string;
  patterns: RegExp[];
}

export interface CompatibilityAssessment {
  compatible: boolean;
  incompatible: string[];
  message: string | null;
}

export const SUPPORTED_TECHNOLOGIES = [
  'Vite',
  'React 19',
  'TypeScript',
  'CSS convencional',
  'Aplicaciones web SPA estáticas y responsive',
  'APIs del navegador y localStorage',
  // Puerta dinámica abierta el 2026-10-16: el piloto full-stack superó el
  // criterio de §9.16 (3 pasadas E2E en Oracle). Solo la plantilla fija
  // templates/dynamic-react-node; nada de backends o BBDD arbitrarias.
  'Aplicaciones full-stack dinámicas (piloto)',
  'Backend Node.js + Fastify (plantilla fija)',
  'SQLite por proyecto (migraciones versionadas)',
  'Autenticación email + contraseña (Argon2, cookie HttpOnly)',
] as const;

const UNSUPPORTED_TECHNOLOGIES: TechnologyRule[] = [
  { label: 'Next.js', patterns: [/\bnext(?:\s*\.\s*js|js)\b/] },
  { label: 'Vue / Nuxt', patterns: [/\bvue(?:\s*\.\s*js|js)?\b/, /\bnuxt(?:\s*\.\s*js|js)?\b/] },
  { label: 'Angular', patterns: [/\bangular\b/] },
  { label: 'Svelte / SvelteKit', patterns: [/\bsvelte(?:kit)?\b/, /\bsvelte\s+kit\b/] },
  { label: 'Astro / Remix / Solid / Qwik', patterns: [/\bastro\b/, /\bremix\b/, /\bsolid(?:js)?\b/, /\bqwik\b/] },
  { label: 'Tailwind CSS', patterns: [/\btailwind(?:\s*css)?\b/] },
  { label: 'shadcn/ui', patterns: [/\bshadcn(?:\s*\/\s*ui)?\b/] },
  { label: 'Bootstrap', patterns: [/\bbootstrap\b/] },
  { label: 'Material UI / MUI / Chakra UI', patterns: [/\bmaterial\s*ui\b/, /\bmui\b/, /\bchakra(?:\s*ui)?\b/] },
  { label: 'Sass / SCSS / styled-components', patterns: [/\bsass\b/, /\bscss\b/, /\bstyled[ -]components\b/] },
  { label: 'Backend Express / NestJS', patterns: [/\bexpress(?:js)?\b/, /\bnest(?:js)?\b/] },
  { label: 'Backend Python', patterns: [/\bpython\b/, /\bdjango\b/, /\bflask\b/, /\bfastapi\b/] },
  { label: 'Backend PHP / Laravel', patterns: [/\bphp\b/, /\blaravel\b/] },
  { label: 'Backend Ruby / Rails', patterns: [/\bruby\b/, /\bruby\s+on\s+rails\b/] },
  { label: 'Backend Java / Spring', patterns: [/\bjava\b/, /\bspring\s*boot\b/] },
  { label: 'Backend .NET / C#', patterns: [/\b\.net\b/, /\bdotnet\b/, /\bc\s*#\b/] },
  { label: 'Base de datos externa', patterns: [/\bpostgres(?:ql)?\b/, /\bmysql\b/, /\bmaria\s*db\b/, /\bmongodb\b/, /\bprisma\b/] },
  { label: 'Supabase / Firebase', patterns: [/\bsupabase\b/, /\bfirebase\b/] },
  { label: 'OAuth / login social', patterns: [/\boauth\b/, /\boidc\b/, /\bsaml\b/, /\bsocial\s+login\b/, /\binicio\s+de\s+sesion\s+con\s+google\b/, /\blogin\s+with\s+google\b/] },
  { label: 'Aplicación móvil o de escritorio', patterns: [/\breact\s+native\b/, /\bflutter\b/, /\belectron\b/] },
];

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function isNegated(text: string, matchIndex: number): boolean {
  const prefix = text.slice(Math.max(0, matchIndex - 60), matchIndex);
  return /(?:\bno\s+(?:usar|uses?|quiero|incluyas?|necesito)|\bsin|\bevita(?:r)?|\bwithout|\bdo\s+not\s+use|\bdon't\s+use|\bavoid)\s+(?:\w+[\s,]+){0,3}$/.test(prefix);
}

function formatMessage(incompatible: string[], language: CompatibilityLanguage): string {
  if (language === 'en') {
    return [
      'This request is not compatible with the technologies currently supported by AppForge.',
      '',
      'Incompatible technologies or capabilities detected:',
      ...incompatible.map((item) => `- ${item}`),
      '',
      'Technologies currently supported:',
      ...SUPPORTED_TECHNOLOGIES.map((item) => `- ${item}`),
      '',
      'No agent run or build was started, so this check did not consume generation tokens. Please reformulate the request using the supported stack.',
    ].join('\n');
  }

  return [
    'Esta solicitud no es compatible con las tecnologías admitidas actualmente por AppForge.',
    '',
    'Tecnologías o capacidades incompatibles detectadas:',
    ...incompatible.map((item) => `- ${item}`),
    '',
    'Tecnologías permitidas actualmente:',
    ...SUPPORTED_TECHNOLOGIES.map((item) => `- ${item}`),
    '',
    'No se ha iniciado el agente ni ningún build, por lo que esta comprobación no ha consumido tokens de generación. Reformula la solicitud utilizando el stack permitido.',
  ].join('\n');
}

export function assessTechnologyCompatibility(
  prompt: string,
  language: CompatibilityLanguage = 'es',
): CompatibilityAssessment {
  const text = normalize(prompt);
  const incompatible = UNSUPPORTED_TECHNOLOGIES.filter((technology) =>
    technology.patterns.some((pattern) => {
      const match = pattern.exec(text);
      pattern.lastIndex = 0;
      return match != null && !isNegated(text, match.index);
    }),
  ).map((technology) => technology.label);

  return {
    compatible: incompatible.length === 0,
    incompatible,
    message: incompatible.length > 0 ? formatMessage(incompatible, language) : null,
  };
}
