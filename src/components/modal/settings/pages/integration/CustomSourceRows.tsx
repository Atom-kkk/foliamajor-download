import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Reveal, Row, Status, TextField, Toggle } from '../../kit';
import { O } from './options';
import { useCustomSource } from './useCustomSource';

// src/components/modal/settings/pages/integration/CustomSourceRows.tsx
// The custom-source rows of the 连接与集成 page: the switch, the service's address and token under
// it, and a last row that tests the service and saves the address (saving reloads the window: the
// provider registry decides what a source can do when it registers, so a new address only becomes
// real after a reload).
//
// Testing is deliberately a real request to /search: a wrong port, a missing CORS header and a
// service that answers something else all look like "the source does not work" from the player,
// and that is exactly the difference this row is here to tell apart.

export const CustomSourceRows: React.FC = () => {
    const { t } = useTranslation();
    const source = useCustomSource();
    const busy = source.action !== 'idle';
    const statusText = source.summary
        ?? (source.configured ? t('options.customSourceConfigured') : t('options.customSourceNotConfigured'));

    return (
        <>
            <Row option={O.customSource} hint={t('options.customSourceDesc')}>
                <Toggle checked={source.draft.enabled} onChange={enabled => source.update({ enabled })} />
            </Row>
            <Reveal when={source.draft.enabled || source.dirty}>
                <Row sub option={O.customSourceUrl}>
                    <TextField
                        type="url"
                        value={source.draft.baseUrl}
                        onChange={baseUrl => source.update({ baseUrl })}
                        placeholder="http://127.0.0.1:8787"
                    />
                </Row>
                <Row sub option={O.customSourceToken}>
                    <TextField
                        type="password"
                        value={source.draft.token}
                        onChange={token => source.update({ token })}
                        placeholder={t('options.customSourceTokenPlaceholder')}
                    />
                </Row>
                <Row sub label={<Status tone={source.tone}>{statusText}</Status>}>
                    <Button onClick={() => void source.test()} disabled={!source.configured || busy}>
                        {source.action === 'testing' ? t('options.customSourceTesting') : t('options.customSourceTest')}
                    </Button>
                    <Button variant="primary" onClick={source.saveAndReload} disabled={!source.dirty || busy}>
                        {source.action === 'saving' ? t('options.customSourceSavedReloading') : t('options.customSourceSaveReload')}
                    </Button>
                </Row>
            </Reveal>
        </>
    );
};

export default CustomSourceRows;
