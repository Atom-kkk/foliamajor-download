import { Download, Globe, Palette, Radio, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// src/components/modal/newFeaturesRelease.ts

type NewFeatureCard = {
    id: string;
    icon: LucideIcon;
};

type NewFeaturesRelease = {
    i18nKey: string;
    /** 重大更新：介绍上方显示「<代号> Update · 重大更新」标签；代号不翻译，文案在 help.majorUpdateLabel。
     *  servicePack：同一重大更新的热修复版，标签改成「<代号> Update SP<n> · 重大更新」，文案在 help.servicePackLabel。 */
    majorUpdate?: { codename: string; servicePack?: number };
    features: NewFeatureCard[];
};

// Defines the current release's cards; their localized text lives under i18nKey in every locale.
// 这一版讲 0.8.12：新增聚合音源、换源时用登录账号兜底、合入上游 0.7.29 的隐喻样式。
// 卡片顺序就是读者会遇到的顺序：先有源，才有「这个源放不出来怎么办」。
export const NEW_FEATURES_RELEASE: NewFeaturesRelease = {
    i18nKey: 'releaseNotes.v0_8_12',
    features: [
        { id: 'sources', icon: Radio },
        { id: 'fallback', icon: RefreshCw },
        { id: 'crossPlatform', icon: Globe },
        { id: 'download', icon: Download },
        { id: 'lyricStyles', icon: Palette },
    ],
};
