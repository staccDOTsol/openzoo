/* Open Cline as the only pane. CSS hides the rest; this focuses the view. */
const vscode = require('vscode');

async function tryCmd(id) {
  try {
    await vscode.commands.executeCommand(id);
    return true;
  } catch {
    return false;
  }
}

async function activate() {
  const focus = [
    'workbench.view.extension.claude-dev-ActivityBar',
    'claude-dev.SidebarProvider.focus',
    'cline.plusButtonClicked',
  ];
  for (const id of focus) {
    if (await tryCmd(id)) break;
  }
  await tryCmd('workbench.action.activityBarLocation.hide');
}

exports.activate = activate;
exports.deactivate = function deactivate() {};
