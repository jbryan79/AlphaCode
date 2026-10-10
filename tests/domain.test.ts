import { describe, expect, it } from 'vitest';
import { addPane, defaultState, createPane, dropTarget, duplicatePane, moveWorkspace, reorderPane, swapPane, applyPreset, removePane, validatePane, validateState, validateWorkspace } from '../shared/domain';

describe('workspace behavior', () => {
  it('vault panes carry a profile and never auto-start', () => {
    const pane = createPane('vault', 'D:\\x', 'prof');
    expect(pane.type).toBe('vault'); expect(pane.profileId).toBe('prof'); expect(pane.autoStart).toBe(false); expect(pane.title).toBe('Vault');
  });
  it('accent color is optional, normalized, and restricted to the palette', () => {
    const legacy={...createPane('powershell','C:\\x')} as any; delete legacy.color;
    expect(validatePane(legacy).color).toBe('');
    expect(validatePane({...createPane('claude','C:\\x'),color:'blue'}).color).toBe('blue');
    expect(()=>validatePane({...createPane('claude','C:\\x'),color:'#ff0000'})).toThrow('Invalid pane color');
  });
  it('moving the root rewrites pane directories under it and leaves others alone', () => {
    const w=defaultState('D:\\Dev\\old').workspaces[0]; w.panes[4].cwd='D:\\Dev\\older'; w.panes[5].cwd='E:\\other';
    const m=moveWorkspace(w,'C:\\new');
    expect(m.root).toBe('C:\\new'); expect(m.panes[0].cwd).toBe('C:\\new\\workspaces\\claude-a'); expect(m.panes[6].cwd).toBe('C:\\new');
    expect(m.panes[4].cwd).toBe('D:\\Dev\\older'); expect(m.panes[5].cwd).toBe('E:\\other');
  });
  it('defaults to eight independent panes and four separate Claude directories', () => {
    const s = defaultState('D:\\Dev\\clauDashole'); const w = s.workspaces[0];
    expect(w.panes).toHaveLength(8);
    expect(w.panes.map(p => p.type)).toEqual(['claude','claude','claude','claude','powershell','powershell-admin','local-model','local-model']);
    expect(new Set(w.panes.slice(0,4).map(p => p.cwd)).size).toBe(4);
    expect(w.panes[5].autoStart).toBe(false);
    expect(new Set(w.panes.map(p => p.id)).size).toBe(8);
  });
  it('a dropped pane targets the origin pane it overlaps most, or nothing on empty space', () => {
    const w = defaultState('D:\\Dev\\x').workspaces[0], [a,,c,d] = w.layout;
    expect(dropTarget(w.layout,{...a,x:1,y:4})?.i).toBe(c.i);
    expect(dropTarget(w.layout,{...a,x:5,y:5})?.i).toBe(d.i);
    expect(dropTarget(w.layout,{...a,y:40})).toBeUndefined();
  });
  it('reorders without changing session identities or configuration', () => {
    const w = defaultState('D:\\Dev\\clauDashole').workspaces[0]; const moved = reorderPane(w, w.panes[0].id, w.panes[3].id);
    expect(moved.panes[3]).toEqual(w.panes[0]); expect(moved.layout.map(x => x.i)).toEqual(moved.panes.map(p => p.id));
    expect(w.panes[0].title).toBe('Claude A');
  });
  it('swaps positions while preserving custom sizes', () => {
    const w = defaultState('D:\\Dev\\clauDashole').workspaces[0]; w.layout[0].w=7; w.layout[1].w=5;
    const a=w.panes[0].id,b=w.panes[1].id; const swapped=swapPane(w,a,b);
    expect(swapped.layout.find(l=>l.i===a)?.w).toBe(5);
    expect(swapped.layout.find(l=>l.i===b)?.w).toBe(7);
  });
  it('duplicates configuration into a fresh independent pane and accepts odd counts', () => {
    const w = defaultState('D:\\Dev\\clauDashole').workspaces[0]; const next=duplicatePane(w,w.panes[0].id);
    expect(next.panes).toHaveLength(9); expect(next.panes[8].id).not.toBe(w.panes[0].id);
    expect(next.panes[8].cwd).toBe(w.panes[0].cwd);
    expect(validateWorkspace(next).panes).toHaveLength(9);
  });
  it('presets can shrink or grow while keeping existing configs', () => {
    const w=defaultState('D:\\Dev\\clauDashole').workspaces[0]; const four=applyPreset(w,4); const six=applyPreset(four,6);
    expect(four.panes).toHaveLength(4); expect(six.panes).toHaveLength(6);
    expect(six.panes.slice(0,4)).toEqual(w.panes.slice(0,4));
    const one=applyPreset(w,1); expect(one.panes).toEqual([w.panes[0]]); expect(one.layout).toEqual([{i:w.panes[0].id,x:0,y:0,w:12,h:4,minW:3,minH:3}]);
    expect(validateWorkspace(one).layout[0].w).toBe(12);
  });
  it('can close all panes and add another later', () => {
    let w=defaultState('D:\\Dev\\clauDashole').workspaces[0]; for(const p of w.panes) w=removePane(w,p.id);
    expect(w.panes).toHaveLength(0); expect(createPane('cmd',w.root).type).toBe('cmd');
  });
  it('a lone pane fills the grid whether it got there by closing others or by being added to an empty workspace', () => {
    let w=defaultState('D:\\Dev\\clauDashole').workspaces[0]; for(const p of w.panes.slice(1)) w=removePane(w,p.id);
    expect(w.layout).toEqual([{i:w.panes[0].id,x:0,y:0,w:12,h:4,minW:3,minH:3}]);
    const fresh=addPane(removePane(w,w.panes[0].id),createPane('cmd',w.root));
    expect(fresh.layout[0]).toMatchObject({x:0,y:0,w:12});
    const two=addPane(fresh,createPane('cmd',w.root)); expect(two.layout[1]).toMatchObject({w:6});
  });
  it('rejects invalid or duplicate IDs and foreign layout references', () => {
    const w=defaultState('D:\\Dev\\clauDashole').workspaces[0];
    expect(()=>validateWorkspace({...w,panes:[w.panes[0],w.panes[0]]})).toThrow();
    expect(()=>validateWorkspace({...w,layout:[{i:'missing',x:0,y:0,w:6,h:1}]})).toThrow();
    expect(()=>validateState({version:3})).toThrow();
  });
  it('roundtrips state and rejects dangerous endpoints and incomplete active workspace', () => {
    const s=defaultState('D:\\Dev\\clauDashole'); expect(validateState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(()=>validateState({...s,activeWorkspaceId:'unknown'})).toThrow();
    s.profiles[0].endpoint='http://example.com'; expect(()=>validateState(s)).toThrow();
  });
});
