import { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Sheet, SheetButton } from '../shared/Sheet';
import { Group, type SettingsGroupDef } from './settings/kit';
import { copyText } from '../../utils/system/clipboard';

// src/components/modal/AiHelpPromptModal.tsx
// The 遇到问题？ dialog of the Help page: a prompt to copy for an AI model, which names this
// build's repository. The hand-off to the upstream documentation site and Discord server that
// used to sit above it is gone: this is a modified build, and pointing people at a guide for the
// original code sends them to answers that do not describe what they are running.

// 这个构建的仓库（fork）。上游地址在帮助页最下面一行。
const FOLIA_REPOSITORY_URL = 'https://github.com/Atom-kkk/foliamajor-download';

const ASK_AI: SettingsGroupDef = { id: 'aiHelpPrompt', titleKey: 'aiHelp.askAiTitle' };

type AiHelpPromptModalProps = {
    isOpen: boolean;
    isDaylight: boolean;
    onClose: () => void;
};

export const AiHelpPromptModal: React.FC<AiHelpPromptModalProps> = ({
    isOpen,
    isDaylight,
    onClose,
}) => {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);

    const prompt = useMemo(() => t('aiHelp.prompt', {
        repoUrl: FOLIA_REPOSITORY_URL,
        defaultValue: [
            `I am using Folia Download, a build modified from the open-source project folia-major, and I need help with a problem.`,
            '',
            `Project: ${FOLIA_REPOSITORY_URL}`,
            '',
            'Help me work out what is wrong with this build and give me steps I can try safely. Ask for any missing details before making assumptions.'
        ].join('\n')
    }), [t]);

    const handleCopyPrompt = async () => {
        try {
            await copyText(prompt);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch (error) {
            console.error('Failed to copy AI help prompt:', error);
            setCopied(false);
        }
    };

    return (
        <Sheet
            isOpen={isOpen}
            onClose={onClose}
            isDaylight={isDaylight}
            size="m"
            title={t('aiHelp.title')}
            footer={(
                <>
                    <SheetButton onClick={onClose}>{t('ui.cancel')}</SheetButton>
                    <SheetButton variant="primary" onClick={() => void handleCopyPrompt()}>
                        {/* Both states lie in one cell, so the button keeps its width when its text changes. */}
                        <span className="grid justify-items-center">
                            <span className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 ${copied ? 'invisible' : ''}`}>
                                <Copy size={14} />
                                {t('aiHelp.copyPrompt')}
                            </span>
                            <span className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 ${copied ? '' : 'invisible'}`}>
                                <Check size={14} />
                                {t('status.copied')}
                            </span>
                        </span>
                    </SheetButton>
                </>
            )}
        >
            {/* A group keeps the space a settings page has above its first card; here the sheet's own padding is that space. */}
            <div className="-mt-5">
                <Group def={ASK_AI} foot={t('aiHelp.usageHint')}>
                    <pre className="select-text whitespace-pre-wrap break-words px-4 py-3.5 font-mono text-xs leading-[19px] text-[color:var(--st-t1)]">
                        {prompt}
                    </pre>
                </Group>
            </div>
        </Sheet>
    );
};
