/** The general add button in the Terminal groups header. Its prompt asks for the group and the folder (terminalOpenAsk "pickGroupAndFolder"). */
export function GroupHeaderAddButton({ onClick }: { onClick: () => void }) {
  return <button className="ib workspace-terminal-add-button" type="button" aria-label="Add terminal to group" title="Add terminal to group" onClick={onClick}>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6l5 5-5 5M11 18h9" /></svg>
  </button>;
}

/** A group row's add button. The group is already known, so its prompt asks only for the folder (terminalOpenAsk "folderOnly"). */
export function GroupRowAddButton({ groupName, onClick }: { groupName: string; onClick: () => void }) {
  return <button className="ib" type="button" aria-label={`New terminal in ${groupName}`} title={`New terminal in ${groupName}`} onClick={onClick}>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg>
  </button>;
}
