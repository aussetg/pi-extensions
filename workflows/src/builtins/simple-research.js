export const meta = {
  name: 'simple_research',
  description: 'Fan out three short research angles and synthesize them',
  phases: [
    { title: 'Research' },
    { title: 'Synthesis' },
  ],
};

phase('Research');
const angles = args?.angles ?? ['architecture', 'risks', 'tests'];
const findings = await parallel(angles.map((angle) => () => agent(`Research ${angle} for the task: ${args?.question ?? ''}`, {
  label: `research ${angle}`,
})));

phase('Synthesis');
return await agent('Synthesize these findings:\n' + JSON.stringify(findings), {
  label: 'final synthesis',
});
