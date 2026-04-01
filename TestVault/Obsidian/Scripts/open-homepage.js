module.exports = async (params) => {
    const { app } = params;
    const FILE_PATH = "Homepage.md"; // adapte si besoin

    const file = app.vault.getFileByPath(FILE_PATH);
    if (!file) {
        console.error(`Fichier introuvable : ${FILE_PATH}`);
        return;
    }

    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });

    const viewState = leaf.getViewState();
    if (viewState?.type === "markdown") {
        viewState.state = viewState.state || {};
        viewState.state.mode = "preview"; // Reading view
        await leaf.setViewState(viewState);
    }

    app.workspace.setActiveLeaf(leaf, { focus: true });
};