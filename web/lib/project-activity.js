'use client';
import { useState } from 'react';
import { api as accountApi } from './api.js';
// C134: project selection survives the existing date/model form and applies to every export page.
export function projectActivityPath(path, project) {
  if (!project) return path;
  const url = new URL(path, 'https://router.example');
  url.searchParams.set('project', project);
  return url.pathname + url.search;
}
export function useProjectActivity(refresh) {
  const [project, setProject] = useState('');
  return { project, changeProject: value => { setProject(value); refresh(old => old + 1); }, api: (path, options) => accountApi(projectActivityPath(path, project), options) };
}
